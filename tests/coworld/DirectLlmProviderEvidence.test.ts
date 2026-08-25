import { beforeAll, describe, expect, it, vi } from "vitest";

import { normalizeProviderEvidence } from "../../coworld-adapter/src/coworld-decision-wire";

type Agent = {
  decide: (request: Record<string, unknown>) => Promise<{
    selectedLegalActionId: string;
    reason?: string;
    confidence?: number;
  }>;
};

type EvidenceRecorder = {
  beginDecision: () => void;
  decisionID: () => number;
  start: (value: Record<string, unknown>) => number | null;
  complete: (attempt: number | null, value?: Record<string, unknown>) => void;
  fail: (attempt: number | null, error: unknown) => void;
  take: () => Record<string, unknown> | undefined;
  summary: (reason: string) => Record<string, unknown>;
};

type SocketLike = {
  on: (event: string, handler: (value?: unknown) => void) => SocketLike;
  send: (payload: string) => void;
  close: () => void;
};

let createStarterAgent: (options: Record<string, unknown>) => Agent;
let boundedLlmTimeoutMs: (value: unknown) => number;
let createActionProviderEvidenceRecorder: () => EvidenceRecorder;
let trackActionComplete: (
  complete: (prompt: string) => Promise<string>,
  descriptor: Record<string, unknown>,
  recorder: EvidenceRecorder,
) => (prompt: string) => Promise<string>;
let decisionResponseForLlmRequest: (input: {
  message: Record<string, unknown>;
  agent: Agent;
  providerEvidenceRecorder: EvidenceRecorder;
}) => Promise<Record<string, unknown>>;
let attachDirectLlmSocketHandlers: (input: {
  socket: SocketLike;
  agent: Agent;
  providerEvidenceRecorder: EvidenceRecorder;
}) => { settled: () => Promise<unknown> };
let createBedrockCompleteForClient: (
  client: Record<string, unknown>,
  recorder: EvidenceRecorder,
  options?: Record<string, unknown>,
) => (prompt: string) => Promise<string>;
let isProviderTimeoutError: (error: unknown) => boolean;
let strictBedrockSidecarEndpoint: (value: unknown) => string | undefined;

beforeAll(async () => {
  const frameworkModulePath =
    "../../examples/external-agent/starter-framework.mjs";
  const playerModulePath = "../../coworld-adapter/src/llm-player.mjs";
  const framework = await import(frameworkModulePath);
  const player = await import(playerModulePath);
  createStarterAgent = framework.createStarterAgent;
  boundedLlmTimeoutMs = player.boundedLlmTimeoutMs;
  createActionProviderEvidenceRecorder =
    player.createActionProviderEvidenceRecorder;
  trackActionComplete = player.trackActionComplete;
  decisionResponseForLlmRequest = player.decisionResponseForLlmRequest;
  attachDirectLlmSocketHandlers = player.attachDirectLlmSocketHandlers;
  createBedrockCompleteForClient = player.createBedrockCompleteForClient;
  isProviderTimeoutError = player.isProviderTimeoutError;
  strictBedrockSidecarEndpoint = player.strictBedrockSidecarEndpoint;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ControlledSocket implements SocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closeCount = 0;
  private readonly handlers = new Map<
    string,
    Array<(value?: unknown) => void>
  >();

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
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.closeCount += 1;
  }
}

function action(id: string, kind: string) {
  return {
    id,
    kind,
    label: id,
    risk: { level: kind === "hold" ? "none" : "low", score: 0.1 },
  };
}

function message(
  requestID: string,
  legalActions = [action("attack:one", "attack"), action("hold", "hold")],
) {
  return {
    type: "decision_request",
    requestID,
    protocol: { maxSpawnPreferences: 16 },
    request: {
      match: { gameID: "provider-evidence-test" },
      agent: { agentID: "provider-agent", profile: "opportunistic" },
      observation: { phase: "active", visiblePlayers: [] },
      legalActions,
    },
  };
}

describe("direct LLM selector provider evidence", () => {
  it("accepts only credential-free loopback HTTP sidecars", () => {
    expect(strictBedrockSidecarEndpoint(" http://127.0.0.1:9100 ")).toBe(
      "http://127.0.0.1:9100",
    );
    expect(strictBedrockSidecarEndpoint("http://localhost:9100")).toBe(
      "http://localhost:9100",
    );
    expect(strictBedrockSidecarEndpoint(undefined)).toBeUndefined();
    for (const invalid of [
      "https://127.0.0.1:9100",
      "http://bedrock-sidecar:9100",
      "http://127.0.0.1",
      "http://user:pass@127.0.0.1:9100",
      "http://127.0.0.1:9100/path",
      "http://127.0.0.1:9100/?query=1",
      "http://127.0.0.1:9100/#fragment",
    ]) {
      expect(() => strictBedrockSidecarEndpoint(invalid)).toThrow(
        "bedrock-sidecar-endpoint-invalid",
      );
    }
  });

  it.each([
    [{ name: "AbortError" }],
    [{ code: "ABORT_ERR" }],
    [{ code: "ETIMEDOUT" }],
    [new Error("request timeout")],
  ])("classifies abort and SDK timeout shape %#", (error) => {
    expect(isProviderTimeoutError(error)).toBe(true);
  });

  it.each([
    [undefined, 12_000],
    ["garbage", 12_000],
    [Number.NaN, 12_000],
    [-1, 250],
    [100, 250],
    [8_000, 8_000],
    [99_999, 12_000],
  ])("bounds provider timeout %s to %s ms", (input, expected) => {
    expect(boundedLlmTimeoutMs(input)).toBe(expected);
  });

  it("puts strict action-call evidence on the JSON response after a real completion", async () => {
    const recorder = createActionProviderEvidenceRecorder();
    const complete = trackActionComplete(
      async () =>
        JSON.stringify({
          selectedLegalActionId: "attack:one",
          reason: "press the open border",
          confidence: 0.8,
        }),
      { provider: "openrouter", requestedModel: "test/action-model" },
      recorder,
    );
    const agent = createStarterAgent({
      llmComplete: complete,
      modelName: "test/action-model",
    });

    const response = JSON.parse(
      JSON.stringify(
        await decisionResponseForLlmRequest({
          message: message("success-1"),
          agent,
          providerEvidenceRecorder: recorder,
        }),
      ),
    ) as Record<string, unknown>;

    expect(response).toMatchObject({
      type: "decision_response",
      requestID: "success-1",
      selectedLegalActionId: "attack:one",
      runtimeMode: "llm-action-selector",
      providerEvidence: {
        callKind: "action",
        provider: "openrouter",
        requestedModel: "test/action-model",
        attemptedModels: ["test/action-model"],
        attemptCount: 1,
        completedAttemptCount: 1,
        failedAttemptCount: 0,
        timedOutAttemptCount: 0,
        rawOutputPresent: true,
      },
    });
    expect(normalizeProviderEvidence(response.providerEvidence)).toEqual(
      response.providerEvidence,
    );
  });

  it("attests an actual failed attempt on the degraded fallback response", async () => {
    const recorder = createActionProviderEvidenceRecorder();
    const calls = vi.fn(async () => {
      throw new Error("provider invocation failed");
    });
    const complete = trackActionComplete(
      calls,
      { provider: "local-command", requestedModel: "provider-default" },
      recorder,
    );
    const agent = createStarterAgent({ llmComplete: complete });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await decisionResponseForLlmRequest({
        message: message("failure-1"),
        agent,
        providerEvidenceRecorder: recorder,
      });
      expect(calls).toHaveBeenCalled();
      expect(response).toMatchObject({
        requestID: "failure-1",
        selectedLegalActionId: "attack:one",
        fallbackUsed: true,
        llmPlannerDegraded: true,
        providerEvidence: {
          callKind: "action",
          provider: "local-command",
          requestedModel: "provider-default",
          attemptedModels: ["provider-default", "provider-default"],
          attemptCount: 2,
          completedAttemptCount: 0,
          failedAttemptCount: 2,
          timedOutAttemptCount: 0,
          rawOutputPresent: false,
        },
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("omits evidence for the deterministic spawn ballot but exposes invalid attribution", async () => {
    const recorder = createActionProviderEvidenceRecorder();
    const calls = vi.fn(async () =>
      JSON.stringify({
        selectedLegalActionId: "attack:one",
        reason: "legal",
        confidence: 0.7,
      }),
    );
    const agent = createStarterAgent({
      llmComplete: trackActionComplete(
        calls,
        { provider: "bad provider", requestedModel: "bad model" },
        recorder,
      ),
    });

    const spawnResponse = await decisionResponseForLlmRequest({
      message: message("spawn-1", [action("spawn:one", "spawn")]),
      agent,
      providerEvidenceRecorder: recorder,
    });
    expect(calls).not.toHaveBeenCalled();
    expect(spawnResponse).not.toHaveProperty("providerEvidence");

    const malformedDescriptorResponse = await decisionResponseForLlmRequest({
      message: message("bad-descriptor-1"),
      agent,
      providerEvidenceRecorder: recorder,
    });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(malformedDescriptorResponse).toHaveProperty("providerEvidence");
    expect(
      normalizeProviderEvidence(malformedDescriptorResponse.providerEvidence),
    ).toBeNull();
    expect(malformedDescriptorResponse.providerEvidence).toMatchObject({
      attemptCount: 1,
      completedAttemptCount: 1,
      invalidAttribution: true,
    });
  });

  it("aggregates every repair attempt in one bounded terminal envelope", async () => {
    const recorder = createActionProviderEvidenceRecorder();
    let attempt = 0;
    const complete = trackActionComplete(
      async () => {
        attempt += 1;
        return attempt === 1
          ? '{"selectedLegalActionId":"invented"}'
          : JSON.stringify({
              selectedLegalActionId: "attack:one",
              reason: "repaired legal choice",
              confidence: 0.7,
            });
      },
      { provider: "openrouter", requestedModel: "test/action-model" },
      recorder,
    );
    const agent = createStarterAgent({ llmComplete: complete });
    const response = await decisionResponseForLlmRequest({
      message: message("repair-1"),
      agent,
      providerEvidenceRecorder: recorder,
    });
    expect(attempt).toBe(2);
    expect(response.providerEvidence).toMatchObject({
      attemptedModels: ["test/action-model", "test/action-model"],
      attemptCount: 2,
      completedAttemptCount: 2,
      failedAttemptCount: 0,
      timedOutAttemptCount: 0,
      rawOutputPresent: true,
    });
    expect(normalizeProviderEvidence(response.providerEvidence)).not.toBeNull();
  });

  it("omits aggregate tokens that overflow the wire cap without losing counts", () => {
    const recorder = createActionProviderEvidenceRecorder();
    recorder.beginDecision();
    const first = recorder.start({
      provider: "openrouter",
      requestedModel: "test/overflow-model",
    });
    recorder.complete(first, {
      inputTokens: 600_000_000,
      outputTokens: 10,
      rawOutputPresent: true,
    });
    const second = recorder.start({
      provider: "openrouter",
      requestedModel: "test/overflow-model",
    });
    recorder.complete(second, {
      inputTokens: 600_000_001,
      outputTokens: 20,
      rawOutputPresent: true,
    });
    const evidence = recorder.take();
    expect(evidence).toMatchObject({
      attemptCount: 2,
      completedAttemptCount: 2,
      outputTokens: 30,
      rawOutputPresent: true,
    });
    expect(evidence).not.toHaveProperty("inputTokens");
    expect(normalizeProviderEvidence(evidence)).not.toBeNull();
  });

  it("caps an all-candidate hang at one aggregate deadline", async () => {
    const recorder = createActionProviderEvidenceRecorder();
    recorder.beginDecision();
    const callOptions: Array<Record<string, unknown>> = [];
    const client = {
      messages: {
        create: vi.fn(
          (
            _request: Record<string, unknown>,
            options: Record<string, unknown>,
          ) => {
            callOptions.push(options);
            return new Promise(() => {});
          },
        ),
      },
    };
    const complete = createBedrockCompleteForClient(client, recorder, {
      modelCandidates: ["model-a", "model-b", "model-c", "model-d"],
      timeoutMs: 250,
      provider: "aws-bedrock",
    });
    const startedAt = performance.now();
    await expect(complete("bounded prompt")).rejects.toThrow(/timed out/);
    const retryStartedAt = performance.now();
    await expect(complete("repair prompt")).rejects.toThrow(/timed out/);
    const retryElapsedMs = performance.now() - retryStartedAt;
    const elapsedMs = performance.now() - startedAt;
    const evidence = recorder.take();
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
    expect(elapsedMs).toBeLessThan(750);
    expect(retryElapsedMs).toBeLessThan(100);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(callOptions[0]).toMatchObject({ maxRetries: 0 });
    expect(callOptions[0].timeout).toEqual(expect.any(Number));
    expect(Number(callOptions[0].timeout)).toBeGreaterThan(0);
    expect(Number(callOptions[0].timeout)).toBeLessThanOrEqual(250);
    expect(callOptions[0].signal).toBeInstanceOf(AbortSignal);
    expect(evidence).toMatchObject({
      attemptedModels: ["model-a"],
      attemptCount: 1,
      completedAttemptCount: 0,
      failedAttemptCount: 0,
      timedOutAttemptCount: 1,
      rawOutputPresent: false,
    });
  });

  it("classifies a provider deadline as a terminal timed-out attempt", async () => {
    const recorder = createActionProviderEvidenceRecorder();
    const complete = trackActionComplete(
      async () => {
        throw new Error("provider timed out");
      },
      { provider: "openrouter", requestedModel: "test/action-model" },
      recorder,
    );
    const agent = createStarterAgent({ llmComplete: complete });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await decisionResponseForLlmRequest({
        message: message("timeout-1"),
        agent,
        providerEvidenceRecorder: recorder,
      });
      expect(response.providerEvidence).toMatchObject({
        attemptCount: 1,
        completedAttemptCount: 0,
        failedAttemptCount: 0,
        timedOutAttemptCount: 1,
        rawOutputPresent: false,
      });
      expect(
        normalizeProviderEvidence(response.providerEvidence),
      ).not.toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("serializes overlapping requests and drains accepted work before final", async () => {
    const recorder = createActionProviderEvidenceRecorder();
    const first = deferred<string>();
    const second = deferred<string>();
    const completions = [first, second];
    const calls = vi.fn(async () => {
      const next = completions[calls.mock.calls.length - 1];
      if (!next) throw new Error("unexpected provider call");
      return next.promise;
    });
    const agent = createStarterAgent({
      llmComplete: trackActionComplete(
        calls,
        { provider: "openrouter", requestedModel: "test/serialized-model" },
        recorder,
      ),
      modelName: "test/serialized-model",
    });
    const socket = new ControlledSocket();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const runtime = attachDirectLlmSocketHandlers({
        socket,
        agent,
        providerEvidenceRecorder: recorder,
      });
      socket.emit("message", JSON.stringify(message("overlap-1")));
      socket.emit("message", JSON.stringify(message("overlap-2")));
      socket.emit("message", JSON.stringify({ type: "final" }));
      socket.emit("message", JSON.stringify(message("after-final")));

      await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
      expect(socket.sent).toHaveLength(0);
      expect(socket.closeCount).toBe(0);

      first.resolve(
        JSON.stringify({
          selectedLegalActionId: "attack:one",
          reason: "first accepted request",
          confidence: 0.8,
        }),
      );
      await vi.waitFor(() => {
        expect(socket.sent).toHaveLength(1);
        expect(calls).toHaveBeenCalledTimes(2);
      });
      expect(socket.sent[0]).toMatchObject({
        requestID: "overlap-1",
        providerEvidence: {
          callKind: "action",
          attemptedModels: ["test/serialized-model"],
          attemptCount: 1,
          completedAttemptCount: 1,
          failedAttemptCount: 0,
          timedOutAttemptCount: 0,
        },
      });
      expect(socket.closeCount).toBe(0);

      second.resolve(
        JSON.stringify({
          selectedLegalActionId: "hold",
          reason: "second accepted request",
          confidence: 0.7,
        }),
      );
      await runtime.settled();

      expect(socket.sent.map((response) => response.requestID)).toEqual([
        "overlap-1",
        "overlap-2",
      ]);
      expect(socket.sent[1]).toMatchObject({
        providerEvidence: {
          callKind: "action",
          attemptedModels: ["test/serialized-model"],
          attemptCount: 1,
          completedAttemptCount: 1,
          failedAttemptCount: 0,
          timedOutAttemptCount: 0,
        },
      });
      expect(socket.sent[0].providerEvidence).not.toBe(
        socket.sent[1].providerEvidence,
      );
      expect(calls).toHaveBeenCalledTimes(2);
      expect(socket.closeCount).toBe(1);
      expect(logs.at(-1)).toContain("PROXYWAR_LLM_ACTION_USAGE");
      expect(logs.at(-1)).toContain('"decisionsWithProviderCalls":2');
    } finally {
      logSpy.mockRestore();
    }
  });
});
