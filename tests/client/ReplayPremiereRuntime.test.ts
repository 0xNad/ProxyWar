import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (
    key: string,
    params?: Record<string, string | number>,
  ): string =>
    params === undefined
      ? key
      : `${key}:${Object.entries(params)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(",")}`,
}));

import {
  ReplayPremiereNetworkError,
  type ReplayPremiereManifest,
  type ReplayPremiereNetworkCallbacks,
  type ReplayPremierePreRevealManifest,
  type ReplayPremiereReadyProjection,
  type ReplayPremiereReveal,
  type ReplayPremiereRevealPointer,
} from "../../src/client/ReplayPremiereNetwork";
import type {
  ReplayPremiereOverlayCallbacks,
  ReplayPremiereOverlayModel,
} from "../../src/client/ReplayPremiereOverlay";
import {
  parseReplayPremiereRoute,
  ReplayPremiereRuntimeController,
  ReplayPremiereServiceClient,
  ReplayPremiereServiceError,
  type ReplayPremiereServiceCheckpoint,
  type ReplayPremiereServiceHeartbeatResponse,
  type ReplayPremiereServiceReactionResponse,
  type ReplayPremiereServiceSession,
  type ReplayPremiereServiceSessionResponse,
} from "../../src/client/ReplayPremiereRuntime";
import type { GameStartInfo } from "../../src/core/Schemas";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";

const PREMIERE_ID = "prem_0123456789abcdef";
const OTHER_PREMIERE_ID = "prem_fedcba9876543210";
const SESSION_ID = `sess_${"1".repeat(32)}`;
const OTHER_SESSION_ID = `sess_${"2".repeat(32)}`;
const PARTICIPANT_ID = `guest_${"3".repeat(32)}`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const STARTED_AT = "2026-07-20T18:00:00.000Z";
const CSRF_TOKEN = `v1.abc.${"4".repeat(32)}.${"5".repeat(64)}`;

afterEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Replay Premiere route gate", () => {
  it("accepts only the exact canonical /premiere/:id pathname", () => {
    expect(parseReplayPremiereRoute(`/premiere/${PREMIERE_ID}`)).toBe(
      PREMIERE_ID,
    );
    expect(
      parseReplayPremiereRoute(`/premiere/${PREMIERE_ID}/extra`),
    ).toBeNull();
    expect(parseReplayPremiereRoute("/premiere/prem_SHORT")).toBeNull();
    expect(
      parseReplayPremiereRoute(`/premiere/${PREMIERE_ID}%2fbootstrap`),
    ).toBeNull();
  });
});

describe("ReplayPremiereRuntimeController", () => {
  it("binds verified projection, creates the session, and only then dispatches the progressive join", async () => {
    const sessionDeferred = deferred<ReplayPremiereServiceSessionResponse>();
    const order: string[] = [];
    const startSession = vi.fn(async () => {
      order.push("session");
      return sessionDeferred.promise;
    });
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession,
        onBind: () => order.push("bind"),
      },
      onJoin: () => order.push("join"),
    });

    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledOnce());

    expect(order).toEqual(["bind", "session"]);
    expect(harness.onJoin).not.toHaveBeenCalled();
    sessionDeferred.resolve(sessionResponse("playing"));

    await started;
    expect(order).toEqual(["bind", "session", "join"]);
    expect(harness.onJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        premiereId: PREMIERE_ID,
        gameID: "PREM0001",
        readyState: "playing",
        progressiveReplay: expect.objectContaining({ playbackRate: 2 }),
      }),
    );
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      canPredict: true,
      canMark: true,
      canShare: true,
    });
    harness.runtime.dispose();
  });

  it("retries a transient session bootstrap without latching a fatal state", async () => {
    vi.useFakeTimers();
    const startSession = vi
      .fn<() => Promise<ReplayPremiereServiceSessionResponse>>()
      .mockRejectedValueOnce(
        new ReplayPremiereServiceError(
          "request_failed",
          502,
          null,
          "response_status",
        ),
      )
      .mockResolvedValueOnce(sessionResponse("playing"));
    const harness = runtimeHarness({
      state: "playing",
      service: { startSession },
    });

    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await Promise.resolve();
    await Promise.resolve();

    expect(startSession).toHaveBeenCalledOnce();
    expect(harness.onJoin).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.failureCode).toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(startSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await started;

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(harness.onJoin).toHaveBeenCalledOnce();
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("recovers a session-gated join within five seconds when a hung production request spans restoration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT));
    let available = false;
    let requestNumber = 0;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestNumber += 1;
        if (requestNumber === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        }
        if (!available) return Promise.reject(new TypeError("unavailable"));
        return Promise.resolve(jsonResponse(sessionResponse("playing"), 201));
      },
    );
    const service = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: window.location.origin,
      fetchImpl: fetchMock as unknown as typeof fetch,
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    let callbacks!: ReplayPremiereNetworkCallbacks;
    const onJoin = vi.fn();
    const models: ReplayPremiereOverlayModel[] = [];
    const runtime = new ReplayPremiereRuntimeController({
      premiereId: PREMIERE_ID,
      onJoinReady: onJoin,
      dependencies: {
        windowRef: window,
        documentRef: document,
        serviceFactory: () => service,
        networkFactory: (options) => {
          callbacks = options.callbacks;
          return {
            start: vi.fn(async () => ({ status: "active" })),
            syncOnce: vi.fn(async () => ({ status: "active" })),
            dispose: vi.fn(),
          };
        },
        overlayFactory: (model) => {
          models.push(model);
          return {
            element: document.createElement("aside"),
            hydrate(nextModel) {
              models.push(nextModel);
            },
            dispose: vi.fn(),
          };
        },
      },
    });

    const started = runtime.start();
    await callbacks.onReady?.(projection("playing"));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    available = true;
    const restoredAt = Date.now();
    await vi.advanceTimersByTimeAsync(2_998);
    expect(onJoin).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await started;

    expect(onJoin).toHaveBeenCalledOnce();
    expect(Date.now() - restoredAt).toBe(2_999);
    expect(models.at(-1)).toMatchObject({
      state: "playing",
      failureCode: null,
    });
    runtime.dispose();
  });

  it("retries a transient heartbeat within one second without latching a fatal state", async () => {
    vi.useFakeTimers();
    const heartbeat = vi
      .fn<() => Promise<ReplayPremiereServiceHeartbeatResponse>>()
      .mockRejectedValueOnce(
        new ReplayPremiereServiceError(
          "request_failed",
          502,
          null,
          "response_status",
        ),
      )
      .mockResolvedValueOnce(heartbeatResponse("playing"));
    const harness = runtimeHarness({
      state: "playing",
      service: { heartbeat },
    });

    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await started;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(heartbeat).toHaveBeenCalledOnce();
    expect(harness.models.at(-1)?.failureCode).toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(heartbeat).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("maintains one bounded heartbeat retry loop across a persistent outage", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => {
      throw new ReplayPremiereServiceError(
        "request_failed",
        502,
        null,
        "response_status",
      );
    });
    const harness = runtimeHarness({
      state: "playing",
      service: { heartbeat },
    });

    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await started;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeat).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(heartbeat).toHaveBeenCalledTimes(5);
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      failureCode: null,
    });
    harness.runtime.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heartbeat).toHaveBeenCalledTimes(5);
  });

  it("keeps transient marker failure recoverable but latches a strict marker response failure", async () => {
    const submitReaction = vi
      .fn<() => Promise<ReplayPremiereServiceReactionResponse>>()
      .mockRejectedValueOnce(
        new ReplayPremiereServiceError(
          "request_failed",
          502,
          null,
          "response_status",
        ),
      )
      .mockRejectedValueOnce(
        new ReplayPremiereServiceError(
          "invalid_response",
          200,
          null,
          "response_binding",
        ),
      );
    const harness = runtimeHarness({
      state: "playing",
      service: { submitReaction },
    });
    const record = {
      sequence: 0,
      presentationOffsetMs: 0,
      turn: { turnNumber: 0, intents: [] },
    };
    harness.runtime.playback.appendVerifiedBatch({
      premiereId: PREMIERE_ID,
      chunkIndex: 0,
      chunkHash: HASH_A,
      previousChunkHash: null,
      payloadHash: HASH_B,
      startSequence: 0,
      endSequence: 0,
      verification: {
        payloadHashVerified: true,
        chunkHashVerified: true,
      },
      records: [record],
    });
    harness.runtime.playback.acknowledgeDispatchedRecord(record);
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await started;
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 0, turnNumber: 0, players: [] },
      }),
    );
    const marker = {
      premiereId: PREMIERE_ID,
      kind: "smart" as const,
      sequence: 0,
      turn: 0,
      policySeatId: null,
    };

    await expect(
      harness.overlayCallbacks.onMarker?.(marker),
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      failureCode: null,
    });
    await expect(
      harness.overlayCallbacks.onMarker?.(marker),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(harness.models.at(-1)).toMatchObject({
      state: "failed",
      failureCode: "integrity_failure",
    });
    harness.runtime.dispose();
  });

  it("never reports a 4,096-turn dispatch window as observed before its rendered frame", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT));
    const harness = runtimeHarness({ state: "checkpoint" });
    const records = Array.from({ length: 4_096 }, (_, sequence) => ({
      sequence,
      presentationOffsetMs: sequence * 10,
      turn: { turnNumber: sequence, intents: [] },
    }));
    harness.runtime.playback.appendVerifiedBatch({
      premiereId: PREMIERE_ID,
      chunkIndex: 0,
      chunkHash: HASH_A,
      previousChunkHash: null,
      payloadHash: HASH_B,
      startSequence: 0,
      endSequence: 4_095,
      verification: {
        payloadHashVerified: true,
        chunkHashVerified: true,
      },
      records,
    });
    for (const record of records) {
      harness.runtime.playback.acknowledgeDispatchedRecord(record);
    }
    expect(harness.runtime.playback.state().lastDispatchedSequence).toBe(4_095);

    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("checkpoint"));
    await started;
    expect(harness.service.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ observedSequence: -1 }),
    );

    await harness.callbacks.onManifest?.(
      checkpointManifest(STARTED_AT, "2026-07-20T18:00:30.000Z"),
    );
    expect(harness.models.at(-1)).toMatchObject({
      releasedSequence: -1,
      activeCheckpointId: null,
      checkpoints: [
        expect.objectContaining({
          id: "cp_12345678",
          state: "pending",
          options: [],
        }),
        expect.anything(),
      ],
    });
    await expect(
      harness.overlayCallbacks.onMarker?.({
        premiereId: PREMIERE_ID,
        kind: "smart",
        sequence: 10,
        turn: 11,
        policySeatId: null,
      }),
    ).rejects.toBeInstanceOf(ReplayPremiereServiceError);
    expect(harness.service.submitReaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.service.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ observedSequence: -1 }),
    );

    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 10, turnNumber: 11, players: [] },
      }),
    );
    expect(harness.models.at(-1)).toMatchObject({
      releasedSequence: 10,
      activeCheckpointId: "cp_12345678",
      checkpoints: [
        expect.objectContaining({ id: "cp_12345678", state: "open" }),
        expect.anything(),
      ],
    });
    await harness.overlayCallbacks.onMarker?.({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 10,
      turn: 11,
      policySeatId: null,
    });
    expect(harness.service.submitReaction).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.service.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ observedSequence: 10 }),
    );
    harness.runtime.dispose();
  });

  it.each([
    {
      label: "first",
      checkpointIndex: 0,
      checkpointId: "cp_12345678",
      checkpointSequence: 10,
    },
    {
      label: "second",
      checkpointIndex: 1,
      checkpointId: "cp_abcdef12",
      checkpointSequence: 20,
    },
  ])(
    "keeps $label checkpoint catch-up in playing recovery until its rendered boundary",
    async ({ checkpointIndex, checkpointId, checkpointSequence }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(STARTED_AT));
      const closesAt = "2026-07-20T18:00:30.000Z";
      const interaction = sessionResponse("checkpoint");
      interaction.checkpoints[checkpointIndex] = {
        ...checkpoint(checkpointId, checkpointSequence),
        opensAt: STARTED_AT,
        closesAt,
        optionSeatIds: ["seat_a", "seat_b"],
        state: "open",
      };
      const harness = runtimeHarness({
        state: "checkpoint",
        service: { startSession: vi.fn(async () => interaction) },
      });

      const started = harness.runtime.start();
      await harness.callbacks.onReady?.(projection("checkpoint"));
      await started;
      expect(harness.models.at(-1)).toMatchObject({
        state: "playing",
        activeCheckpointId: null,
      });

      await harness.callbacks.onRecovering?.({
        code: "request_failed",
        attempt: 1,
        retryInMs: 250,
      });
      expect(harness.models.at(-1)).toMatchObject({
        state: "playing",
        activeCheckpointId: null,
        recovery: { attempt: 1, retryInMs: 250 },
      });

      await harness.callbacks.onManifest?.(
        checkpointManifest(
          STARTED_AT,
          closesAt,
          checkpointId,
          checkpointSequence,
        ),
      );
      const records = Array.from(
        { length: checkpointSequence + 1 },
        (_, sequence) => ({
          sequence,
          presentationOffsetMs: sequence * 10,
          turn: { turnNumber: sequence, intents: [] },
        }),
      );
      harness.runtime.playback.appendVerifiedBatch({
        premiereId: PREMIERE_ID,
        chunkIndex: 0,
        chunkHash: HASH_A,
        previousChunkHash: null,
        payloadHash: HASH_B,
        startSequence: 0,
        endSequence: checkpointSequence,
        verification: {
          payloadHashVerified: true,
          chunkHashVerified: true,
        },
        records,
      });
      for (const record of records) {
        harness.runtime.playback.acknowledgeDispatchedRecord(record);
      }

      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: {
            sequence: checkpointSequence - 1,
            turnNumber: checkpointSequence - 1,
            players: [],
          },
        }),
      );
      expect(harness.models.at(-1)).toMatchObject({
        state: "playing",
        activeCheckpointId: null,
      });

      document.dispatchEvent(
        new CustomEvent("ai-league-replay-frame", {
          detail: {
            sequence: checkpointSequence,
            turnNumber: checkpointSequence,
            players: [],
          },
        }),
      );
      expect(harness.models.at(-1)).toMatchObject({
        state: "checkpoint",
        activeCheckpointId: checkpointId,
        checkpoints: expect.arrayContaining([
          expect.objectContaining({
            id: checkpointId,
            state: "open",
          }),
        ]),
      });
      harness.runtime.dispose();
    },
  );

  it("keeps a mismatched active checkpoint fail-closed instead of projecting catch-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT));
    const closesAt = "2026-07-20T18:00:30.000Z";
    const interaction = sessionResponse("checkpoint");
    interaction.checkpoints[0] = {
      ...checkpoint("cp_12345678", 10),
      opensAt: STARTED_AT,
      closesAt,
      optionSeatIds: ["seat_a", "seat_b"],
      state: "open",
    };
    const harness = runtimeHarness({
      state: "checkpoint",
      service: { startSession: vi.fn(async () => interaction) },
    });

    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("checkpoint"));
    await started;
    await harness.callbacks.onManifest?.(
      checkpointManifest(STARTED_AT, closesAt, "cp_deadbeef", 10),
    );

    expect(harness.models.at(-1)).toMatchObject({
      state: "checkpoint",
      activeCheckpointId: null,
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it.each([
    {
      label: "structured service error",
      failure: Object.assign(
        new ReplayPremiereServiceError(
          "request_rejected",
          403,
          "PREMIERE_INVALID_REQUEST",
          "response_status",
        ),
        { privateUpstreamBody: "token=/private/operator/path" },
      ),
      expected:
        "Replay Premiere interaction bootstrap failed code=request_rejected status=403 publicCode=PREMIERE_INVALID_REQUEST phase=response_status",
    },
    {
      label: "arbitrary exception",
      failure: Object.assign(new Error("token=/private/operator/path"), {
        responseBody: "secret upstream response",
      }),
      expected:
        "Replay Premiere interaction bootstrap failed code=unexpected_failure status=none publicCode=none phase=unexpected",
    },
  ])(
    "logs only bounded bootstrap diagnostics for a $label",
    async (testCase) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const harness = runtimeHarness({
        state: "playing",
        service: {
          startSession: vi.fn(async () => {
            throw testCase.failure;
          }),
        },
      });

      const started = harness.runtime.start();
      await harness.callbacks.onReady?.(projection("playing"));
      await expect(started).rejects.toBeInstanceOf(ReplayPremiereNetworkError);

      expect(errorLog).toHaveBeenCalledWith(testCase.expected);
      expect(errorLog.mock.calls[0]).toHaveLength(1);
      const serializedLog = JSON.stringify(errorLog.mock.calls);
      expect(serializedLog).not.toContain("private/operator");
      expect(serializedLog).not.toContain("secret upstream");
      expect(serializedLog).not.toContain("privateUpstreamBody");
      expect(serializedLog).not.toContain("responseBody");
      harness.runtime.dispose();
    },
  );

  it("joins a verified archive read-only without any POST capability or session bootstrap", async () => {
    vi.useFakeTimers();
    const harness = runtimeHarness({ state: "archived" });
    const started = harness.runtime.start();
    await harness.callbacks.onManifest?.(archivedPointer());
    await harness.callbacks.onReady?.(projection("archived"));
    await Promise.resolve();

    expect(harness.service.startSession).not.toHaveBeenCalled();
    expect(harness.onJoin).not.toHaveBeenCalled();
    await harness.callbacks.onTerminal?.("archived");
    expect(harness.onJoin).not.toHaveBeenCalled();

    await harness.callbacks.onReveal?.(verifiedReveal());
    await started;
    expect(harness.onJoin).toHaveBeenCalledOnce();
    expect(harness.onJoin).toHaveBeenCalledWith(
      expect.objectContaining({ readyState: "archived" }),
    );
    expect(harness.service.startSession).not.toHaveBeenCalled();
    expect(harness.models.at(-1)).toMatchObject({
      state: "archived",
      canPredict: false,
      canMark: false,
      canShare: false,
    });

    await expect(
      harness.overlayCallbacks.onPrediction?.({
        premiereId: PREMIERE_ID,
        checkpointId: "cp_12345678",
        selectedSeatId: "seat_a",
      }),
    ).rejects.toBeInstanceOf(ReplayPremiereServiceError);
    await expect(
      harness.overlayCallbacks.onMarker?.({
        premiereId: PREMIERE_ID,
        kind: "smart",
        sequence: 0,
        turn: 0,
        policySeatId: null,
      }),
    ).rejects.toBeInstanceOf(ReplayPremiereServiceError);
    await expect(
      harness.overlayCallbacks.onShare?.({
        premiereId: PREMIERE_ID,
        kind: "timestamp",
        url: `https://proxywar.example/premiere/${PREMIERE_ID}`,
        sequence: 0,
        turn: 0,
      }),
    ).rejects.toBeInstanceOf(ReplayPremiereServiceError);
    expect(harness.service.submitPrediction).not.toHaveBeenCalled();
    expect(harness.service.submitReaction).not.toHaveBeenCalled();
    expect(harness.service.createShare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.service.heartbeat).not.toHaveBeenCalled();
    harness.runtime.dispose();
  });

  it("keeps a fatal integrity state sticky across later frame, manifest, recovery, and heartbeat callbacks", async () => {
    vi.useFakeTimers();
    const heartbeatDeferred =
      deferred<ReplayPremiereServiceHeartbeatResponse>();
    const harness = runtimeHarness({
      state: "playing",
      service: {
        heartbeat: vi.fn(() => heartbeatDeferred.promise),
      },
    });
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await started;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.service.heartbeat).toHaveBeenCalledOnce();

    await harness.callbacks.onFatalError?.(
      new ReplayPremiereNetworkError("manifest_integrity_failure", false),
    );
    const fatalModelIndex = harness.models.length - 1;
    expect(harness.models[fatalModelIndex]).toMatchObject({
      state: "failed",
      failureCode: "integrity_failure",
    });

    await harness.callbacks.onRecovering?.({
      code: "request_failed",
      attempt: 2,
      retryInMs: 500,
    });
    await harness.callbacks.onManifest?.(playingManifest());
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: {
          turnNumber: 12,
          players: [
            { playerID: "seat_a", displayName: "Alpha", tilesOwned: 10 },
            { playerID: "seat_b", displayName: "Beta", tilesOwned: 9 },
          ],
        },
      }),
    );
    heartbeatDeferred.resolve(heartbeatResponse("playing"));
    await Promise.resolve();
    await Promise.resolve();

    expect(
      harness.models
        .slice(fatalModelIndex)
        .every(
          (model) =>
            model.state === "failed" &&
            model.failureCode === "integrity_failure",
        ),
    ).toBe(true);
    expect(harness.network.dispose).toHaveBeenCalled();
    expect(harness.service.dispose).toHaveBeenCalled();
    harness.runtime.dispose();
  });

  it("preserves the original sanitized fatal error before readiness and keeps the failure sticky", async () => {
    const harness = runtimeHarness({ state: "revealed" });
    const originalError = new ReplayPremiereNetworkError(
      "invalid_schema",
      false,
    );
    const started = harness.runtime.start();
    const rejected = expect(started).rejects.toBe(originalError);
    await harness.callbacks.onReady?.(projection("revealed"));

    await harness.callbacks.onFatalError?.(originalError);
    await rejected;
    const fatalModelIndex = harness.models.length - 1;
    expect(harness.models[fatalModelIndex]).toMatchObject({
      state: "failed",
      failureCode: "integrity_failure",
    });
    expect(harness.network.dispose).toHaveBeenCalledOnce();
    expect(harness.service.dispose).toHaveBeenCalledOnce();

    await harness.callbacks.onRecovering?.({
      code: "request_failed",
      attempt: 2,
      retryInMs: 500,
    });
    await harness.callbacks.onManifest?.(playingManifest());
    expect(
      harness.models
        .slice(fatalModelIndex)
        .every(
          (model) =>
            model.state === "failed" &&
            model.failureCode === "integrity_failure",
        ),
    ).toBe(true);
    harness.runtime.dispose();
  });

  it("projects the verified server failure boundary before any replay frame is observed", async () => {
    const harness = runtimeHarness({ state: "failed" });
    const started = harness.runtime.start();

    await harness.callbacks.onManifest?.(releasedFailedManifest());
    await harness.callbacks.onReady?.(projection("failed"));
    await started;

    expect(harness.models.at(-1)).toMatchObject({
      state: "failed",
      releasedSequence: 2,
      failureCode: null,
      canPredict: false,
      canMark: false,
      canShare: false,
    });
    expect(harness.onJoin).not.toHaveBeenCalled();
    harness.runtime.dispose();
  });

  it.each(["integrity", "runtime"] as const)(
    "keeps a client-originated %s failure on the observed frame boundary",
    async (failureKind) => {
      const harness = runtimeHarness({ state: "failed" });
      const started = harness.runtime.start();

      await harness.callbacks.onManifest?.(releasedFailedManifest());
      await harness.callbacks.onReady?.(projection("failed"));
      await started;
      expect(harness.models.at(-1)?.releasedSequence).toBe(2);

      if (failureKind === "integrity") {
        await harness.callbacks.onFatalError?.(
          new ReplayPremiereNetworkError("invalid_schema", false),
        );
      } else {
        document.dispatchEvent(new CustomEvent("ai-league-replay-load-error"));
      }

      expect(harness.models.at(-1)).toMatchObject({
        state: "failed",
        releasedSequence: -1,
        failureCode:
          failureKind === "integrity" ? "integrity_failure" : "runtime_failure",
      });
      harness.runtime.dispose();
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "makes a %s terminal pointer outrank a stale playing heartbeat and permanently disables writes",
    async (terminalState) => {
      vi.useFakeTimers();
      const heartbeatDeferred =
        deferred<ReplayPremiereServiceHeartbeatResponse>();
      const harness = runtimeHarness({
        state: "playing",
        service: {
          heartbeat: vi.fn(() => heartbeatDeferred.promise),
        },
      });
      const started = harness.runtime.start();
      await harness.callbacks.onReady?.(projection("playing"));
      await started;
      expect(harness.models.at(-1)).toMatchObject({
        state: "playing",
        canPredict: true,
        canMark: true,
        canShare: true,
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.service.heartbeat).toHaveBeenCalledOnce();

      await harness.callbacks.onManifest?.(terminalManifest(terminalState));
      await harness.callbacks.onTerminal?.(terminalState);
      expect(harness.models.at(-1)).toMatchObject({
        state: terminalState,
        canPredict: false,
        canMark: false,
        canShare: false,
        canExportCounterChallenge: false,
      });
      expect(harness.service.dispose).toHaveBeenCalled();

      heartbeatDeferred.resolve(heartbeatResponse("playing"));
      await Promise.resolve();
      await Promise.resolve();
      await harness.callbacks.onManifest?.(playingManifest());
      await harness.callbacks.onRecovering?.({
        code: "request_failed",
        attempt: 3,
        retryInMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(harness.service.heartbeat).toHaveBeenCalledOnce();
      expect(harness.models.at(-1)).toMatchObject({
        state: terminalState,
        canPredict: false,
        canMark: false,
        canShare: false,
      });
      await expect(
        harness.overlayCallbacks.onPrediction?.({
          premiereId: PREMIERE_ID,
          checkpointId: "cp_12345678",
          selectedSeatId: "seat_a",
        }),
      ).rejects.toBeInstanceOf(ReplayPremiereServiceError);
      expect(harness.service.submitPrediction).not.toHaveBeenCalled();
      harness.runtime.dispose();
    },
  );

  it("fences a stale playing heartbeat across the reveal pointer transition", async () => {
    vi.useFakeTimers();
    const heartbeatDeferred =
      deferred<ReplayPremiereServiceHeartbeatResponse>();
    const harness = runtimeHarness({
      state: "playing",
      service: {
        heartbeat: vi.fn(() => heartbeatDeferred.promise),
      },
    });
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await started;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.service.heartbeat).toHaveBeenCalledOnce();

    await harness.callbacks.onManifest?.(revealedPointer());
    heartbeatDeferred.resolve(heartbeatResponse("playing"));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.network.dispose).not.toHaveBeenCalled();
    expect(harness.service.dispose).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.failureCode).toBeNull();

    await harness.callbacks.onReveal?.(verifiedReveal());
    await harness.callbacks.onTerminal?.("revealed");
    expect(harness.network.dispose).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.failureCode).toBeNull();
    harness.runtime.dispose();
  });

  it("fences a stale session bootstrap projection across the reveal pointer transition", async () => {
    const sessionDeferred = deferred<ReplayPremiereServiceSessionResponse>();
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: vi.fn(() => sessionDeferred.promise),
      },
    });
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await vi.waitFor(() =>
      expect(harness.service.startSession).toHaveBeenCalledOnce(),
    );

    await harness.callbacks.onManifest?.(revealedPointer());
    sessionDeferred.resolve(sessionResponseWithIncomingMoment("playing"));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.network.dispose).not.toHaveBeenCalled();
    expect(harness.service.dispose).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.failureCode).toBeNull();
    expect(harness.onJoin).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.canPredict).toBe(false);
    expect(harness.onRevealSeek).not.toHaveBeenCalled();

    await harness.callbacks.onReveal?.(verifiedReveal());
    await harness.callbacks.onTerminal?.("revealed");
    await started;
    expect(harness.network.dispose).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.failureCode).toBeNull();
    expect(harness.onJoin).toHaveBeenCalledOnce();
    expect(harness.onRevealSeek).toHaveBeenCalledOnce();
    expect(harness.onRevealSeek).toHaveBeenCalledWith(12);
    harness.runtime.dispose();
  });

  it("holds a current revealed session projection until the reveal body is verified", async () => {
    const sessionDeferred = deferred<ReplayPremiereServiceSessionResponse>();
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: vi.fn(() => sessionDeferred.promise),
      },
    });
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await vi.waitFor(() =>
      expect(harness.service.startSession).toHaveBeenCalledOnce(),
    );

    await harness.callbacks.onManifest?.(revealedPointer());
    sessionDeferred.resolve(sessionResponse("revealed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.network.dispose).not.toHaveBeenCalled();
    expect(harness.onJoin).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.canPredict).toBe(false);

    await harness.callbacks.onReveal?.(verifiedReveal());
    await harness.callbacks.onTerminal?.("revealed");
    await started;
    expect(harness.onJoin).toHaveBeenCalledOnce();
    expect(harness.models.at(-1)?.failureCode).toBeNull();
    harness.runtime.dispose();
  });

  it("joins read-only after an archived session projection outruns reveal verification", async () => {
    const sessionDeferred = deferred<ReplayPremiereServiceSessionResponse>();
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: vi.fn(() => sessionDeferred.promise),
      },
    });
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await vi.waitFor(() =>
      expect(harness.service.startSession).toHaveBeenCalledOnce(),
    );

    await harness.callbacks.onManifest?.(revealedPointer());
    sessionDeferred.resolve(sessionResponse("archived"));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.onJoin).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.canPredict).toBe(false);

    await harness.callbacks.onReveal?.(verifiedReveal());
    await harness.callbacks.onTerminal?.("revealed");
    await started;
    expect(harness.onJoin).toHaveBeenCalledOnce();
    expect(harness.service.dispose).toHaveBeenCalledOnce();
    expect(harness.models.at(-1)).toMatchObject({
      state: "archived",
      canPredict: false,
      canMark: false,
      canShare: false,
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("activates a fenced session once its stale response lands after reveal verification", async () => {
    const sessionDeferred = deferred<ReplayPremiereServiceSessionResponse>();
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: vi.fn(() => sessionDeferred.promise),
      },
    });
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await vi.waitFor(() =>
      expect(harness.service.startSession).toHaveBeenCalledOnce(),
    );

    await harness.callbacks.onManifest?.(revealedPointer());
    await harness.callbacks.onReveal?.(verifiedReveal());
    await harness.callbacks.onTerminal?.("revealed");
    expect(harness.onJoin).not.toHaveBeenCalled();

    sessionDeferred.resolve(sessionResponseWithIncomingMoment("playing"));
    await started;

    expect(harness.network.dispose).not.toHaveBeenCalled();
    expect(harness.service.dispose).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.failureCode).toBeNull();
    expect(harness.onJoin).toHaveBeenCalledOnce();
    expect(harness.onRevealSeek).toHaveBeenCalledOnce();
    expect(harness.onRevealSeek).toHaveBeenCalledWith(12);
    harness.runtime.dispose();
  });

  it.each([
    {
      label: "lifecycle regression",
      response: () => heartbeatResponse("draft"),
    },
    {
      label: "pre-verification outcome projection",
      response: () => {
        const response = heartbeatResponse("playing");
        response.checkpoints[0].resolution = {
          kind: "winner" as const,
          winnerSeatId: "seat_a",
          resolvedAt: STARTED_AT,
        };
        response.checkpoints[0].crowdAccuracy = {
          correctPredictions: 0,
          totalPredictions: 0,
        };
        return response;
      },
    },
  ])(
    "does not fence a $label behind a reveal pointer",
    async ({ response }) => {
      vi.useFakeTimers();
      const heartbeatDeferred =
        deferred<ReplayPremiereServiceHeartbeatResponse>();
      const harness = runtimeHarness({
        state: "playing",
        service: {
          heartbeat: vi.fn(() => heartbeatDeferred.promise),
        },
      });
      const started = harness.runtime.start();
      await harness.callbacks.onReady?.(projection("playing"));
      await started;
      await vi.advanceTimersByTimeAsync(10_000);

      await harness.callbacks.onManifest?.(revealedPointer());
      heartbeatDeferred.resolve(response());
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.network.dispose).toHaveBeenCalledOnce();
      expect(harness.service.dispose).toHaveBeenCalledOnce();
      expect(harness.models.at(-1)).toMatchObject({
        state: "failed",
        failureCode: "integrity_failure",
      });
      harness.runtime.dispose();
    },
  );

  it("fails closed when interaction outcomes arrive before a verified reveal", async () => {
    const leaked = sessionResponse("playing");
    leaked.checkpoints[0].resolution = {
      kind: "winner",
      winnerSeatId: "seat_a",
      resolvedAt: STARTED_AT,
    };
    leaked.checkpoints[0].crowdAccuracy = {
      correctPredictions: 0,
      totalPredictions: 0,
    };
    const harness = runtimeHarness({
      state: "playing",
      service: { startSession: vi.fn(async () => leaked) },
    });

    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await expect(started).rejects.toBeInstanceOf(ReplayPremiereNetworkError);

    expect(harness.onJoin).not.toHaveBeenCalled();
    expect(harness.models.at(-1)).toMatchObject({
      state: "failed",
      failureCode: "integrity_failure",
    });
    harness.runtime.dispose();
  });

  it("projects a checkpoint closed at the server-authoritative deadline and prompts one deduplicated verification", async () => {
    vi.useFakeTimers();
    const closesAt = "2026-07-20T18:00:15.000Z";
    const interaction = sessionResponse("checkpoint");
    interaction.checkpoints[0] = {
      ...checkpoint("cp_12345678", 10),
      opensAt: STARTED_AT,
      closesAt,
      optionSeatIds: ["seat_a", "seat_b"],
      state: "open",
    };
    const harness = runtimeHarness({
      state: "checkpoint",
      service: {
        startSession: vi.fn(async () => interaction),
      },
    });
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("checkpoint"));
    await started;
    const observedRecords = Array.from({ length: 11 }, (_, sequence) => ({
      sequence,
      presentationOffsetMs: sequence * 10,
      turn: { turnNumber: sequence, intents: [] },
    }));
    harness.runtime.playback.appendVerifiedBatch({
      premiereId: PREMIERE_ID,
      chunkIndex: 0,
      chunkHash: HASH_A,
      previousChunkHash: null,
      payloadHash: HASH_B,
      startSequence: 0,
      endSequence: 10,
      verification: {
        payloadHashVerified: true,
        chunkHashVerified: true,
      },
      records: observedRecords,
    });
    for (const record of observedRecords) {
      harness.runtime.playback.acknowledgeDispatchedRecord(record);
    }
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 10, turnNumber: 11, players: [] },
      }),
    );
    const manifest = checkpointManifest("2026-07-20T18:00:14.600Z", closesAt);
    await harness.callbacks.onManifest?.(manifest);

    expect(harness.models.at(-1)).toMatchObject({
      state: "checkpoint",
      activeCheckpointId: "cp_12345678",
    });
    expect(harness.models.at(-1)?.checkpoints[0]).toMatchObject({
      id: "cp_12345678",
      state: "open",
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(harness.network.syncOnce).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.activeCheckpointId).toBe("cp_12345678");

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      activeCheckpointId: null,
    });
    expect(harness.models.at(-1)?.checkpoints[0]).toMatchObject({
      id: "cp_12345678",
      state: "closed",
    });
    expect(harness.network.syncOnce).toHaveBeenCalledOnce();

    await harness.callbacks.onManifest?.({
      ...manifest,
      serverNow: "2026-07-20T18:00:15.100Z",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.network.syncOnce).toHaveBeenCalledOnce();

    await harness.callbacks.onManifest?.({
      ...playingManifest(),
      serverNow: "2026-07-20T18:00:15.200Z",
      authoritativeElapsedMs: 15_200,
      releasedThroughSequence: 10,
    });
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      activeCheckpointId: null,
    });
    expect(harness.models.at(-1)?.checkpoints[0]).toMatchObject({
      id: "cp_12345678",
      state: "closed",
    });
    harness.runtime.dispose();
  });
});

describe("ReplayPremiereServiceClient", () => {
  it("retries malformed gateway failures with the exact session and heartbeat idempotency envelopes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(malformedGatewayResponse(502))
      .mockResolvedValueOnce(jsonResponse(sessionResponse("playing"), 201))
      .mockResolvedValueOnce(malformedGatewayResponse(502))
      .mockResolvedValueOnce(jsonResponse(heartbeatResponse("playing"), 200))
      .mockResolvedValueOnce(malformedGatewayResponse(502))
      .mockResolvedValueOnce(jsonResponse(reactionResponse(), 200));
    let randomByte = 1;
    const randomBytes = vi.fn(() => new Uint8Array(16).fill(randomByte++));
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes,
    });
    client.bindVerifiedProjection(projection("playing"));
    const sessionInput = { visible: true, observedSequence: -1 };

    await expect(client.startSession(sessionInput)).rejects.toMatchObject({
      code: "request_failed",
      status: 502,
      phase: "response_status",
    });
    expect(client.session()).toBeNull();
    await expect(client.startSession(sessionInput)).resolves.toMatchObject({
      session: { id: SESSION_ID },
    });

    const firstSessionRequest = fetchMock.mock.calls[0][1];
    const retriedSessionRequest = fetchMock.mock.calls[1][1];
    expect(retriedSessionRequest?.body).toBe(firstSessionRequest?.body);
    expect(
      new Headers(retriedSessionRequest?.headers).get("x-idempotency-key"),
    ).toBe(new Headers(firstSessionRequest?.headers).get("x-idempotency-key"));

    await expect(
      client.heartbeat({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({
      code: "request_failed",
      status: 502,
      phase: "response_status",
    });
    expect(client.session()?.id).toBe(SESSION_ID);
    await expect(
      client.heartbeat({ visible: false, observedSequence: 7 }),
    ).resolves.toMatchObject({ session: { id: SESSION_ID } });

    const firstHeartbeatRequest = fetchMock.mock.calls[2][1];
    const retriedHeartbeatRequest = fetchMock.mock.calls[3][1];
    expect(retriedHeartbeatRequest?.body).toBe(firstHeartbeatRequest?.body);
    expect(JSON.parse(String(retriedHeartbeatRequest?.body))).toEqual({
      visible: true,
      observedSequence: -1,
    });
    expect(
      new Headers(retriedHeartbeatRequest?.headers).get("x-idempotency-key"),
    ).toBe(
      new Headers(firstHeartbeatRequest?.headers).get("x-idempotency-key"),
    );

    const marker = {
      premiereId: PREMIERE_ID,
      kind: "smart" as const,
      sequence: 0,
      turn: 0,
      policySeatId: null,
    };
    await expect(client.submitReaction(marker)).rejects.toMatchObject({
      code: "request_failed",
      status: 502,
      phase: "response_status",
    });
    await expect(client.submitReaction(marker)).resolves.toMatchObject({
      reaction: { id: `react_${"7".repeat(32)}` },
    });
    const firstReactionRequest = fetchMock.mock.calls[4][1];
    const retriedReactionRequest = fetchMock.mock.calls[5][1];
    expect(retriedReactionRequest?.body).toBe(firstReactionRequest?.body);
    expect(
      new Headers(retriedReactionRequest?.headers).get("x-idempotency-key"),
    ).toBe(new Headers(firstReactionRequest?.headers).get("x-idempotency-key"));
    expect(randomBytes).toHaveBeenCalledTimes(3);
    client.dispose();
  });

  it.each([408, 425, 429, 500, 502, 503, 599])(
    "classifies malformed HTTP %i as retryable transport evidence before parsing",
    async (status) => {
      const client = new ReplayPremiereServiceClient({
        premiereId: PREMIERE_ID,
        origin: "https://proxywar.example",
        fetchImpl: vi.fn(async () => malformedGatewayResponse(status)),
        randomBytes: () => new Uint8Array(16).fill(1),
      });
      client.bindVerifiedProjection(projection("playing"));

      await expect(
        client.startSession({ visible: true, observedSequence: -1 }),
      ).rejects.toMatchObject({
        code: "request_failed",
        status,
        phase: "response_status",
      });
      expect(client.session()).toBeNull();
      client.dispose();
    },
  );

  it("classifies an HTML 502 without touching its response body", async () => {
    const bodyAccess = vi.fn(() => {
      throw new Error("gateway body must not be read");
    });
    const response = new Response(null, {
      status: 502,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(response, "body", { get: bodyAccess });
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: vi.fn(async () => response),
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({
      code: "request_failed",
      status: 502,
      phase: "response_status",
    });
    expect(bodyAccess).not.toHaveBeenCalled();
    client.dispose();
  });

  it("keeps malformed non-transient 4xx and cache-policy failures fatal", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(malformedGatewayResponse(400))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sessionResponse("playing")), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      status: 400,
      phase: "response_policy",
    });
    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      status: 201,
      phase: "response_policy",
    });
    expect(client.session()).toBeNull();
    client.dispose();
  });

  it("keeps a JSON 502 without no-store fatal as a cache-policy failure", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: "PREMIERE_UNAVAILABLE" } }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      },
    );
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: vi.fn(async () => response),
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
      phase: "response_policy",
    });
    expect(client.session()).toBeNull();
    client.dispose();
  });

  it("preserves strict application-error semantics for valid transient-status JSON envelopes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "PREMIERE_INTEGRITY_FAILURE" } }, 500),
      );
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({
      code: "request_rejected",
      status: 500,
      publicCode: "PREMIERE_INTEGRITY_FAILURE",
      phase: "response_status",
    });
    expect(client.session()).toBeNull();
    client.dispose();
  });

  it("uses the exact same-origin write envelope and rejects a cross-session heartbeat without poisoning the session", async () => {
    const session = sessionResponse("playing");
    const heartbeat = heartbeatResponse("playing", {
      id: OTHER_SESSION_ID,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(session, 201))
      .mockResolvedValueOnce(jsonResponse(heartbeat, 200));
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await client.startSession({ visible: true, observedSequence: -1 });
    const firstCall = fetchMock.mock.calls[0];
    const firstHeaders = new Headers(firstCall[1]?.headers);
    expect(firstCall[0]).toBe(`/api/premieres/${PREMIERE_ID}/sessions`);
    expect(firstCall[1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    // Origin is user-agent controlled; the browser supplies it for the real
    // same-origin POST.
    expect(firstHeaders.has("origin")).toBe(false);
    expect(firstHeaders.get("x-idempotency-key")).toMatch(
      /^idem_[a-f0-9]{32}$/,
    );
    expect(firstHeaders.has("x-csrf-token")).toBe(false);

    await expect(
      client.heartbeat({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(client.session()?.id).toBe(SESSION_ID);
    const heartbeatHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(heartbeatHeaders.get("x-csrf-token")).toBe(CSRF_TOKEN);
    client.dispose();
  });

  it("rejects a structurally valid session bound to another premiere", async () => {
    const crossPremiere = sessionResponse("playing");
    crossPremiere.session.premiereId = OTHER_PREMIERE_ID;
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: vi.fn(async () => jsonResponse(crossPremiere, 201)),
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(client.session()).toBeNull();
    client.dispose();
  });
});

function runtimeHarness(options: {
  state: ReplayPremiereReadyProjection["state"];
  service?: {
    startSession?: () => Promise<ReplayPremiereServiceSessionResponse>;
    heartbeat?: () => Promise<ReplayPremiereServiceHeartbeatResponse>;
    submitReaction?: () => Promise<ReplayPremiereServiceReactionResponse>;
    onBind?: () => void;
  };
  onJoin?: () => void;
  onRevealSeek?: (turn: number) => void;
}) {
  let callbacks!: ReplayPremiereNetworkCallbacks;
  let overlayCallbacks!: ReplayPremiereOverlayCallbacks;
  const models: ReplayPremiereOverlayModel[] = [];
  const network = {
    start: vi.fn(async () => ({ status: "active" })),
    syncOnce: vi.fn(async () => ({ status: "active" })),
    dispose: vi.fn(),
  };
  const service = {
    sessionValue: null as ReplayPremiereServiceSession | null,
    session: vi.fn(() => service.sessionValue),
    bindVerifiedProjection: vi.fn(() => options.service?.onBind?.()),
    startSession: vi.fn(async () => {
      const response =
        (await options.service?.startSession?.()) ??
        sessionResponse(options.state === "archived" ? "archived" : "playing");
      service.sessionValue = response.session;
      return response;
    }),
    refreshSession: vi.fn(async () => sessionResponse("playing")),
    heartbeat:
      options.service?.heartbeat === undefined
        ? vi.fn(async () => heartbeatResponse("playing"))
        : vi.fn(options.service.heartbeat),
    submitPrediction: vi.fn(),
    submitReaction:
      options.service?.submitReaction === undefined
        ? vi.fn()
        : vi.fn(options.service.submitReaction),
    createShare: vi.fn(),
    dispose: vi.fn(),
  };
  const onJoin = vi.fn(options.onJoin);
  const onRevealSeek = vi.fn(options.onRevealSeek);
  const runtime = new ReplayPremiereRuntimeController({
    premiereId: PREMIERE_ID,
    onJoinReady: onJoin,
    onRevealSeek,
    dependencies: {
      windowRef: window,
      documentRef: document,
      networkFactory: (networkOptions) => {
        callbacks = networkOptions.callbacks;
        return network;
      },
      serviceFactory: () => service,
      overlayFactory: (model, nextCallbacks) => {
        models.push(model);
        overlayCallbacks = nextCallbacks ?? {};
        return {
          element: document.createElement("aside"),
          hydrate(nextModel) {
            models.push(nextModel);
          },
          dispose: vi.fn(),
        };
      },
      copyText: vi.fn(async () => undefined),
      downloadReminder: vi.fn(),
    },
  });
  return {
    runtime,
    callbacks,
    get overlayCallbacks() {
      return overlayCallbacks;
    },
    models,
    network,
    service,
    onJoin,
    onRevealSeek,
  };
}

function projection(
  state: ReplayPremiereReadyProjection["state"],
): ReplayPremiereReadyProjection {
  const baseProvenance = {
    sourceKind: "controlled_exhibition" as const,
    sourceRunId: "run_001",
    coworld: null,
    sourceReplaySha256: HASH_A,
    seats: [
      {
        seatId: "seat_a",
        displayName: "Alpha",
        policyIdentity: {
          namespace: "local_manifest" as const,
          manifestName: "alpha",
          declaredVersion: "v1",
          manifestSha256: HASH_B,
          contentSha256: HASH_C,
        },
      },
      {
        seatId: "seat_b",
        displayName: "Beta",
        policyIdentity: {
          namespace: "local_manifest" as const,
          manifestName: "beta",
          declaredVersion: "v1",
          manifestSha256: HASH_C,
          contentSha256: HASH_B,
        },
      },
    ],
    publicLabel: "premiere" as const,
    eligibilityRecordHash: HASH_B,
  };
  return {
    premiereId: PREMIERE_ID,
    gameStartInfo: gameStartInfo(),
    gameStartInfoHash: HASH_A,
    publicDefinition: {
      title: "Alpha vs Beta",
      spoilerNeutralDescription: "A spoiler-neutral replay premiere.",
      map: { id: "asia", label: "Asia" },
      matchFormat: { id: "duel", label: "Duel", seatCount: 2 },
      scheduledAt: STARTED_AT,
      playbackRate: 2,
      checkpoints: [
        { id: "cp_12345678", sequence: 10 },
        { id: "cp_abcdef12", sequence: 20 },
      ],
      provenance: baseProvenance,
    },
    playbackRate: 2,
    state,
    scheduledAt: STARTED_AT,
    actualStartAt: state === "scheduled" ? null : STARTED_AT,
    provenance: {
      ...baseProvenance,
      publicationCommitmentHash: HASH_C,
    },
  };
}

function gameStartInfo(): GameStartInfo {
  return {
    gameID: "PREM0001",
    lobbyCreatedAt: 10,
    config: {
      gameMap: GameMapType.Asia,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Medium,
      nations: "disabled",
      donateGold: false,
      donateTroops: false,
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    },
    players: [
      { clientID: "SEAT0001", username: "Alpha", clanTag: null },
      { clientID: "SEAT0002", username: "Beta", clanTag: null },
    ],
  };
}

function checkpoint(
  id: string,
  sequence: number,
): ReplayPremiereServiceCheckpoint {
  return {
    id,
    sequence,
    opensAt: null,
    closesAt: null,
    outageShiftMs: 0,
    optionSeatIds: [],
    state: "upcoming",
    participantPrediction: null,
    distribution: null,
    totalPredictions: null,
    resolution: null,
    crowdAccuracy: null,
  };
}

function viewerSession(
  overrides: Partial<ReplayPremiereServiceSession> = {},
): ReplayPremiereServiceSession {
  return {
    id: SESSION_ID,
    premiereId: PREMIERE_ID,
    participantId: PARTICIPANT_ID,
    startedAt: STARTED_AT,
    lastHeartbeatAt: STARTED_AT,
    endedAt: null,
    connectedDurationMs: 0,
    visibleDurationMs: 0,
    currentlyVisible: true,
    firstReleasedSequenceObserved: -1,
    lastReleasedSequenceObserved: -1,
    predictionCount: 0,
    reactionCount: 0,
    shareCount: 0,
    incomingAttribution: null,
    excludedAsOperator: false,
    excludedAsBot: false,
    qualifiedAt: null,
    idempotencyKey: `idem_${"01".repeat(16)}`,
    creationRequestHash: HASH_A,
    heartbeatReceipts: [],
    ...overrides,
  };
}

function sessionResponse(
  premiereState: ReplayPremiereServiceSessionResponse["premiereState"],
): ReplayPremiereServiceSessionResponse {
  return {
    schemaVersion: 1,
    csrfToken: CSRF_TOKEN,
    session: viewerSession(),
    premiereState,
    checkpoints: [checkpoint("cp_12345678", 10), checkpoint("cp_abcdef12", 20)],
    incomingMoment: null,
  };
}

function sessionResponseWithIncomingMoment(
  premiereState: ReplayPremiereServiceSessionResponse["premiereState"],
): ReplayPremiereServiceSessionResponse {
  const response = sessionResponse(premiereState);
  const shareId = `share_${"6".repeat(32)}`;
  response.session.incomingAttribution = {
    attributionId: PARTICIPANT_ID,
    shareId,
    premiereId: PREMIERE_ID,
    issuedAt: STARTED_AT,
    expiresAt: "2026-07-20T18:10:00.000Z",
  };
  response.incomingMoment = {
    shareId,
    sequence: 12,
    turn: 12,
  };
  return response;
}

function heartbeatResponse(
  premiereState: ReplayPremiereServiceHeartbeatResponse["premiereState"],
  sessionOverrides: Partial<ReplayPremiereServiceSession> = {},
): ReplayPremiereServiceHeartbeatResponse {
  return {
    schemaVersion: 1,
    session: viewerSession(sessionOverrides),
    idempotent: false,
    persisted: false,
    premiereState,
    checkpoints: [checkpoint("cp_12345678", 10), checkpoint("cp_abcdef12", 20)],
  };
}

function reactionResponse() {
  return {
    schemaVersion: 1 as const,
    reaction: {
      id: `react_${"7".repeat(32)}`,
      premiereId: PREMIERE_ID,
      participantId: PARTICIPANT_ID,
      sequence: 0,
      turn: 0,
      kind: "smart" as const,
      policyIdentity: null,
      eventContext: {},
      createdAt: STARTED_AT,
    },
    idempotent: false,
  };
}

function archivedPointer(): ReplayPremiereRevealPointer {
  const current = projection("archived");
  return {
    schemaVersion: 1,
    premiereId: PREMIERE_ID,
    state: "archived",
    revealUrl: `/api/premieres/${PREMIERE_ID}/reveal`,
    revealedAt: STARTED_AT,
    revealCommitHash: HASH_A,
    provenance: current.provenance,
  };
}

function revealedPointer(): ReplayPremiereRevealPointer {
  return {
    ...archivedPointer(),
    state: "revealed",
  };
}

function playingManifest(): ReplayPremierePreRevealManifest {
  const current = projection("playing");
  return {
    schemaVersion: 1,
    premiereId: PREMIERE_ID,
    state: "playing",
    serverNow: STARTED_AT,
    scheduledAt: STARTED_AT,
    actualStartAt: STARTED_AT,
    playbackRate: 2,
    authoritativeElapsedMs: 0,
    accumulatedPauseMs: 0,
    releasedThroughSequence: -1,
    lastReleasedChunkIndex: -1,
    activeCheckpoint: null,
    provenance: current.provenance,
    releasedChunks: [],
  };
}

function checkpointManifest(
  serverNow: string,
  closesAt: string,
  checkpointId = "cp_12345678",
  checkpointSequence = 10,
): ReplayPremierePreRevealManifest {
  return {
    ...playingManifest(),
    state: "checkpoint",
    serverNow,
    authoritativeElapsedMs: 10_000,
    releasedThroughSequence: checkpointSequence,
    activeCheckpoint: {
      id: checkpointId,
      sequence: checkpointSequence,
      opensAt: STARTED_AT,
      closesAt,
      questionKind: "winner_from_here",
      optionSeatIds: ["seat_a", "seat_b"],
      state: "open",
    },
  };
}

function terminalManifest(
  state: "failed" | "cancelled",
): ReplayPremiereManifest {
  return {
    ...playingManifest(),
    state,
  };
}

function releasedFailedManifest(): ReplayPremierePreRevealManifest {
  return {
    ...playingManifest(),
    state: "failed",
    serverNow: "2026-07-20T18:00:00.100Z",
    authoritativeElapsedMs: 100,
    releasedThroughSequence: 2,
    lastReleasedChunkIndex: 0,
    releasedChunks: [
      {
        premiereId: PREMIERE_ID,
        index: 0,
        startSequence: 0,
        endSequence: 2,
        startTurn: 0,
        endTurn: 2,
        presentationOffsetMs: 100,
        previousChunkHash: null,
        payloadHash: HASH_A,
        chunkHash: HASH_B,
        byteLength: 128,
        terminal: false,
        releasedAt: "2026-07-20T18:00:00.100Z",
      },
    ],
  };
}

function verifiedReveal(): ReplayPremiereReveal {
  const current = projection("archived");
  return {
    schemaVersion: 1,
    premiereId: PREMIERE_ID,
    state: "revealed",
    provenance: current.provenance,
    verifiedAuthoritativeResult: {
      schemaVersion: 1,
      sourceKind: "controlled_result",
      sourceRunId: "run_001",
      sourceId: "result_001",
      gameId: current.gameStartInfo.gameID,
      completedAt: STARTED_AT,
      turnCount: 100,
      winner: ["player", "seat_a"],
      seats: [
        { seatId: "seat_a", displayName: "Alpha", won: true },
        { seatId: "seat_b", displayName: "Beta", won: false },
      ],
    },
  } as unknown as ReplayPremiereReveal;
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, max-age=0",
    },
  });
}

function malformedGatewayResponse(status: number): Response {
  return new Response("<html><body>temporary gateway failure</body></html>", {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
