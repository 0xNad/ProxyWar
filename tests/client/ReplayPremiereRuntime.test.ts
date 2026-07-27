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
  readProxyWarClipGenerationCapabilities,
  type ProxyWarClipGenerationCapabilities,
} from "../../src/client/ClipGenerationCapabilities";
import {
  ReplayPremiereNetworkError,
  type ReplayPremiereClipStatusResponse,
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
  type ReplayPremiereClipEligibility,
  type ReplayPremiereJoinSyncUpdate,
  type ReplayPremiereServiceCheckpoint,
  type ReplayPremiereServiceHeartbeatResponse,
  type ReplayPremiereServiceReactionResponse,
  type ReplayPremiereServiceReactionSummary,
  type ReplayPremiereServiceSession,
  type ReplayPremiereServiceSessionResponse,
  type ReplayPremiereServiceShareResponse,
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
const OTHER_PARTICIPANT_ID = `guest_${"4".repeat(32)}`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const STARTED_AT = "2026-07-20T18:00:00.000Z";
const CSRF_TOKEN = `v1.abc.${"4".repeat(32)}.${"5".repeat(64)}`;
const CLIP_WATCH_URL = `https://proxywar.example/premiere/${PREMIERE_ID}`;
// The caption carries the license lines and NO premiere watch url; the reply
// carries the watch url. Mirrors the server's composePremiereClipSocialText.
const CLIP_CAPTION =
  "AI agents, no humans — a Proxy War league premiere moment.\n\n" +
  "Game art from OpenFront (openfront.io), CC BY-SA 4.0.\n" +
  "Proxy War is an independent fork — not affiliated with OpenFront.";
const CLIP_REPLY = `Watch the full premiere: ${CLIP_WATCH_URL}`;

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

describe("ProxyWar clip-generation capability", () => {
  it.each([
    { premiereGenerationEnabled: true, leagueGenerationEnabled: true },
    { premiereGenerationEnabled: false, leagueGenerationEnabled: false },
  ])("strictly accepts the explicit process capability %#", async (flags) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ schemaVersion: 1, ...flags }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(
      readProxyWarClipGenerationCapabilities(fetchImpl),
    ).resolves.toEqual({ schemaVersion: 1, ...flags });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/clip-capabilities",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it.each([
    {
      name: "transport failure",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("offline");
      }),
    },
    {
      name: "missing endpoint",
      fetchImpl: vi.fn(async () => new Response("not found", { status: 404 })),
    },
    {
      name: "malformed success",
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              premiereGenerationEnabled: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    },
  ])("fails closed on $name", async ({ fetchImpl }) => {
    await expect(
      readProxyWarClipGenerationCapabilities(fetchImpl),
    ).resolves.toEqual({
      schemaVersion: 1,
      premiereGenerationEnabled: false,
      leagueGenerationEnabled: false,
    });
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

  it("bumps the viewer's own mark tally and confirmation on server-accepted reactions", async () => {
    const responses = [
      { idempotent: false, turn: 11 },
      { idempotent: true, turn: 11 },
    ];
    const submitReaction = vi.fn(async (input?: { sequence: number }) => {
      const next = responses.shift()!;
      return {
        schemaVersion: 2,
        reaction: {
          id: `react_${"c".repeat(32)}`,
          premiereId: PREMIERE_ID,
          participantId: PARTICIPANT_ID,
          sequence: input?.sequence ?? 0,
          turn: next.turn,
          kind: "betrayal",
          policyIdentity: null,
          eventContext: {},
          createdAt: STARTED_AT,
        },
        idempotent: next.idempotent,
        reactionSummary: reactionSummaryWith("betrayal", 1),
        clipsEnabled: true,
        clipEligibility: clipEligibility(),
      } as unknown as ReplayPremiereServiceReactionResponse;
    });
    const harness = runtimeHarness({
      state: "playing",
      service: { submitReaction },
    });
    await bootstrapPlayingWithFrame(harness);
    const marker = {
      premiereId: PREMIERE_ID,
      kind: "betrayal" as const,
      sequence: 0,
      turn: 0,
      policySeatId: null,
    };
    await harness.overlayCallbacks.onMarker?.(marker);
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { betrayal: 1 },
      ownMarkerCounts: { betrayal: 1 },
      markerParticipantCount: 1,
      markerConfirmation: { kind: "betrayal", turn: 11 },
    });
    // An idempotent replay confirms but never double-counts.
    await harness.overlayCallbacks.onMarker?.(marker);
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { betrayal: 1 },
      ownMarkerCounts: { betrayal: 1 },
      markerConfirmation: { kind: "betrayal", turn: 11 },
    });
    harness.runtime.dispose();
  });

  it("keeps a newer heartbeat tally when an older in-flight reaction returns", async () => {
    vi.useFakeTimers();
    const pendingReaction = deferred<ReplayPremiereServiceReactionResponse>();
    const heartbeat = heartbeatResponse("playing");
    heartbeat.reactionSummary = reactionSummaryWith("smart", 2);
    const harness = runtimeHarness({
      state: "playing",
      service: {
        submitReaction: () => pendingReaction.promise,
        heartbeat: async () => heartbeat,
      },
    });
    await bootstrapPlayingWithFrame(harness);

    const markerWrite = harness.overlayCallbacks.onMarker?.({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 0,
      turn: 0,
      policySeatId: null,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      markerCounts: { smart: 2 },
      ownMarkerCounts: { smart: 2 },
      failureCode: null,
    });

    pendingReaction.resolve(reactionResponse());
    await markerWrite;
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      markerCounts: { smart: 2 },
      ownMarkerCounts: { smart: 2 },
      markerConfirmation: { kind: "smart", turn: 0 },
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("hydrates an accepted v4 mark and share anchor immediately", async () => {
    const accepted = reactionResponseV4();
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: async () => sessionResponseV4("playing"),
        submitReaction: async () => accepted,
      },
    });
    await bootstrapPlayingWithFrame(harness);

    await harness.overlayCallbacks.onMarker?.({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 0,
      turn: 0,
      policySeatId: null,
    });

    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      ownMarkerCounts: { smart: 1 },
      markerConfirmation: { kind: "smart", turn: 0 },
      share: {
        sourceReactionId: accepted.reaction.id,
        sourceReactionSequence: 0,
        sourceReactionTurn: 0,
      },
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("keeps a newer v4 private anchor when an older reaction response lands", async () => {
    vi.useFakeTimers();
    const pendingReaction = deferred<ReplayPremiereServiceReactionResponse>();
    const newerHeartbeat = heartbeatResponseV4("playing");
    newerHeartbeat.reactionSummary = reactionSummaryWith("smart", 1);
    newerHeartbeat.reactionSummary.totalReactions = 2;
    newerHeartbeat.reactionSummary.byKind.betrayal = 1;
    newerHeartbeat.reactionSummary.ownByKind!.betrayal = 1;
    newerHeartbeat.latestOwnReaction = {
      id: `react_${"8".repeat(32)}`,
      kind: "betrayal",
      sequence: 1,
      turn: 1,
    };
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: async () => sessionResponseV4("playing"),
        submitReaction: () => pendingReaction.promise,
        heartbeat: async () => newerHeartbeat,
      },
    });
    await bootstrapPlayingWithFrame(harness);

    const markerWrite = harness.overlayCallbacks.onMarker?.({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 0,
      turn: 0,
      policySeatId: null,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1, betrayal: 1 },
      ownMarkerCounts: { smart: 1, betrayal: 1 },
      markerConfirmation: { kind: "betrayal", turn: 1 },
      share: {
        sourceReactionId: newerHeartbeat.latestOwnReaction.id,
        sourceReactionSequence: 1,
        sourceReactionTurn: 1,
      },
      failureCode: null,
    });

    pendingReaction.resolve(reactionResponseV4());
    await markerWrite;
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1, betrayal: 1 },
      ownMarkerCounts: { smart: 1, betrayal: 1 },
      markerConfirmation: { kind: "betrayal", turn: 1 },
      share: {
        sourceReactionId: newerHeartbeat.latestOwnReaction.id,
        sourceReactionSequence: 1,
        sourceReactionTurn: 1,
      },
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("keeps private own counts on v1 fallback and upgrades cleanly to v2 crowd state", async () => {
    vi.useFakeTimers();
    const upgradedHeartbeat = heartbeatResponse("playing");
    upgradedHeartbeat.reactionSummary = reactionSummaryWith("smart", 1);
    upgradedHeartbeat.clipsEnabled = true;
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: async () => legacySessionResponse("playing"),
        submitReaction: async () => legacyReactionResponse(),
        heartbeat: async () => upgradedHeartbeat,
      },
    });
    await bootstrapPlayingWithFrame(harness);
    await harness.overlayCallbacks.onMarker?.({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 0,
      turn: 0,
      policySeatId: null,
    });
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      ownMarkerCounts: { smart: 1 },
      clipMarkerAvailable: false,
      failureCode: null,
    });
    expect(harness.models.at(-1)?.markerParticipantCount).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      ownMarkerCounts: { smart: 1 },
      markerParticipantCount: 1,
      clipMarkerAvailable: true,
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("marks cached crowd totals stale and hides clips across a v2 to v1 downgrade", async () => {
    vi.useFakeTimers();
    const initial = sessionResponse("playing");
    initial.reactionSummary = reactionSummaryWith("smart", 1);
    initial.clipsEnabled = true;
    const upgraded = heartbeatResponse("playing");
    upgraded.reactionSummary = reactionSummaryWith("smart", 2);
    upgraded.clipsEnabled = false;
    upgraded.clipEligibility = clipEligibility({
      generationEnabled: false,
      renderableThroughTurn: null,
    });
    let heartbeatCount = 0;
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: async () => initial,
        heartbeat: async () =>
          heartbeatCount++ === 0
            ? legacyHeartbeatResponse("playing")
            : upgraded,
        submitReaction: async () => legacyReactionResponse(),
      },
    });
    await bootstrapPlayingWithFrame(harness);
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      markerAggregateFresh: true,
      clipMarkerAvailable: true,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      ownMarkerCounts: { smart: 1 },
      markerAggregateFresh: false,
      clipMarkerAvailable: false,
      failureCode: null,
    });

    await harness.overlayCallbacks.onMarker?.({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 0,
      turn: 0,
      policySeatId: null,
    });
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      ownMarkerCounts: { smart: 2 },
      markerAggregateFresh: false,
      markerConfirmation: { kind: "smart", turn: 0 },
      clipMarkerAvailable: false,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 2 },
      ownMarkerCounts: { smart: 2 },
      markerAggregateFresh: true,
      clipMarkerAvailable: false,
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("clears private mark state when session recovery rotates the guest identity", async () => {
    vi.useFakeTimers();
    const initial = sessionResponse("playing");
    initial.reactionSummary = reactionSummaryWith("smart", 1);
    const recovered = sessionResponse("playing");
    recovered.session = viewerSession({
      id: OTHER_SESSION_ID,
      participantId: OTHER_PARTICIPANT_ID,
    });
    recovered.reactionSummary = reactionSummaryWith("smart", 2);
    recovered.reactionSummary.ownByKind = { ...emptyReactionSummary().byKind };
    const accepted = reactionResponse();
    accepted.reactionSummary = reactionSummaryWith("smart", 2);
    let bootstrapCount = 0;
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: async () =>
          bootstrapCount++ === 0 ? initial : recovered,
        heartbeat: async () => {
          throw new ReplayPremiereServiceError("request_rejected", 401);
        },
        submitReaction: async () => accepted,
      },
    });
    await bootstrapPlayingWithFrame(harness);
    await harness.overlayCallbacks.onMarker?.({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 0,
      turn: 0,
      policySeatId: null,
    });
    expect(harness.models.at(-1)).toMatchObject({
      ownMarkerCounts: { smart: 2 },
      markerConfirmation: { kind: "smart", turn: 0 },
      share: { sourceReactionId: accepted.reaction.id },
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.service.startSession).toHaveBeenCalledTimes(2);
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 2 },
      ownMarkerCounts: { smart: 0 },
      markerConfirmation: null,
      share: { sourceReactionId: null, sourceReactionTurn: null },
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("does not restore an old guest's private mark when its response loses a recovery race", async () => {
    vi.useFakeTimers();
    const pendingReaction = deferred<ReplayPremiereServiceReactionResponse>();
    const recovered = sessionResponse("playing");
    recovered.session = viewerSession({
      id: OTHER_SESSION_ID,
      participantId: OTHER_PARTICIPANT_ID,
    });
    recovered.reactionSummary = reactionSummaryWith("smart", 1);
    recovered.reactionSummary.ownByKind = { ...emptyReactionSummary().byKind };
    let bootstrapCount = 0;
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: async () =>
          bootstrapCount++ === 0 ? sessionResponse("playing") : recovered,
        heartbeat: async () => {
          throw new ReplayPremiereServiceError("request_rejected", 401);
        },
        submitReaction: () => pendingReaction.promise,
      },
    });
    await bootstrapPlayingWithFrame(harness);
    const markerWrite = harness.overlayCallbacks.onMarker?.({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 0,
      turn: 0,
      policySeatId: null,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
    expect(harness.service.startSession).toHaveBeenCalledTimes(2);
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      ownMarkerCounts: { smart: 0 },
      share: { sourceReactionId: null },
    });

    pendingReaction.resolve(reactionResponse());
    await markerWrite;
    expect(harness.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      ownMarkerCounts: { smart: 0 },
      markerConfirmation: null,
      share: { sourceReactionId: null },
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("does not copy or expose an old guest's share when its response loses a recovery race", async () => {
    vi.useFakeTimers();
    const pendingShare = deferred<ReplayPremiereServiceShareResponse>();
    const recovered = sessionResponse("playing");
    recovered.session = viewerSession({
      id: OTHER_SESSION_ID,
      participantId: OTHER_PARTICIPANT_ID,
    });
    recovered.reactionSummary!.ownByKind = { ...emptyReactionSummary().byKind };
    let bootstrapCount = 0;
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: async () =>
          bootstrapCount++ === 0 ? sessionResponse("playing") : recovered,
        heartbeat: async () => {
          throw new ReplayPremiereServiceError("request_rejected", 401);
        },
        createShare: () => pendingShare.promise,
      },
    });
    await bootstrapPlayingWithFrame(harness);
    const shareWrite = harness.overlayCallbacks.onShare?.({
      premiereId: PREMIERE_ID,
      kind: "timestamp",
      url: `${window.location.origin}/premiere/${PREMIERE_ID}`,
      sequence: 0,
      turn: 0,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
    expect(harness.service.startSession).toHaveBeenCalledTimes(2);

    pendingShare.resolve(shareResponse({ sequence: 0 }));
    await shareWrite;

    expect(harness.service.createShare).toHaveBeenCalledTimes(1);
    expect(harness.copyText).not.toHaveBeenCalled();
    expect(harness.models.at(-1)).toMatchObject({
      share: {
        sourceReactionId: null,
        manualCopyUrl: null,
        manualCopyReason: null,
      },
      canShare: true,
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("turns an accepted mark into an explicitly anchored share moment", async () => {
    const reactionId = `react_${"7".repeat(32)}`;
    const shareId = `share_${"8".repeat(32)}`;
    const attributionToken = `${"a".repeat(16)}.${"b".repeat(16)}`;
    const url = `${window.location.origin}/premiere/${PREMIERE_ID}?moment=${shareId}&attribution=${attributionToken}`;
    const createShare = vi.fn(
      async (input: { sequence: number; sourceReactionId?: string | null }) =>
        ({
          schemaVersion: 1,
          share: {
            id: shareId,
            premiereId: PREMIERE_ID,
            sourceReactionId: input.sourceReactionId ?? null,
            sequence: input.sequence,
            turn: 0,
            createdByParticipantId: PARTICIPANT_ID,
            cardVersion: 1,
            createdAt: STARTED_AT,
            idempotencyKey: `idem_${"9".repeat(32)}`,
          },
          attributionToken,
          url,
          idempotent: false,
        }) as ReplayPremiereServiceShareResponse,
    );
    const harness = runtimeHarness({
      state: "playing",
      service: {
        submitReaction: async () => ({
          ...reactionResponse(),
          reaction: {
            ...reactionResponse().reaction,
            id: reactionId,
            sequence: 0,
            turn: 100,
          },
        }),
        createShare,
      },
    });
    await bootstrapPlayingWithFrame(harness);
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 0, turnNumber: 100, players: [] },
      }),
    );
    await harness.overlayCallbacks.onMarker?.({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 0,
      turn: 100,
      policySeatId: null,
    });
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 0, turnNumber: 150, players: [] },
      }),
    );
    expect(harness.models.at(-1)?.share).toMatchObject({
      sourceReactionId: reactionId,
      sourceReactionSequence: 0,
      sourceReactionTurn: 100,
      suggestedCaption:
        "replay_premiere.share_caption:title=Alpha vs Beta,turn=100",
    });
    expect(harness.models.at(-1)?.currentTurn).toBe(150);

    await harness.overlayCallbacks.onShare?.({
      premiereId: PREMIERE_ID,
      kind: "timestamp",
      url: `https://proxywar.example/premiere/${PREMIERE_ID}`,
      sequence: 0,
      turn: 100,
      sourceReactionId: reactionId,
    });

    expect(createShare).toHaveBeenCalledWith({
      sequence: 0,
      sourceReactionId: reactionId,
    });
    expect(createShare).toHaveBeenCalledTimes(1);
    expect(harness.copyText).toHaveBeenCalledWith(url);
    expect(harness.models.at(-1)?.share?.manualCopyUrl).toBeNull();
    harness.runtime.dispose();
  });

  it("exposes the validated share URL without repeating the server write when clipboard copy is rejected", async () => {
    const createShare = vi.fn(
      async (input: { sequence: number; sourceReactionId?: string | null }) =>
        shareResponse(input),
    );
    const harness = runtimeHarness({
      state: "playing",
      copyText: async () => {
        throw new DOMException(
          "Clipboard permission denied",
          "NotAllowedError",
        );
      },
      service: { createShare },
    });
    await bootstrapPlayingWithFrame(harness);

    await expect(
      harness.overlayCallbacks.onShare?.({
        premiereId: PREMIERE_ID,
        kind: "timestamp",
        url: `${window.location.origin}/premiere/${PREMIERE_ID}`,
        sequence: 0,
        turn: 0,
      }),
    ).resolves.toBeUndefined();

    const url = shareResponse({ sequence: 0 }).url;
    expect(createShare).toHaveBeenCalledTimes(1);
    expect(harness.copyText).toHaveBeenCalledTimes(1);
    expect(harness.copyText).toHaveBeenCalledWith(url);
    expect(harness.models.at(-1)).toMatchObject({
      share: {
        manualCopyUrl: url,
        manualCopyReason: "clipboard_rejected",
      },
      canShare: true,
      failureCode: null,
    });
    harness.runtime.dispose();
  });

  it("exposes the validated share URL when the Clipboard API is unavailable", async () => {
    const navigatorRef = window.navigator as Navigator & {
      clipboard?: Clipboard;
    };
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigatorRef,
      "clipboard",
    );
    Object.defineProperty(navigatorRef, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const createShare = vi.fn(
      async (input: { sequence: number; sourceReactionId?: string | null }) =>
        shareResponse(input),
    );
    const harness = runtimeHarness({
      state: "playing",
      useDefaultCopyText: true,
      service: { createShare },
    });
    try {
      await bootstrapPlayingWithFrame(harness);

      await expect(
        harness.overlayCallbacks.onShare?.({
          premiereId: PREMIERE_ID,
          kind: "timestamp",
          url: `${window.location.origin}/premiere/${PREMIERE_ID}`,
          sequence: 0,
          turn: 0,
        }),
      ).resolves.toBeUndefined();

      const url = shareResponse({ sequence: 0 }).url;
      expect(createShare).toHaveBeenCalledTimes(1);
      expect(harness.copyText).not.toHaveBeenCalled();
      expect(harness.models.at(-1)).toMatchObject({
        share: {
          manualCopyUrl: url,
          manualCopyReason: "clipboard_unavailable",
        },
        canShare: true,
        failureCode: null,
      });
    } finally {
      harness.runtime.dispose();
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigatorRef, "clipboard");
      } else {
        Object.defineProperty(navigatorRef, "clipboard", clipboardDescriptor);
      }
    }
  });

  it("does not retain a URL when createShare fails", async () => {
    const createShare = vi.fn(async () => {
      throw new ReplayPremiereServiceError("request_failed", 503);
    });
    const harness = runtimeHarness({
      state: "playing",
      service: { createShare },
    });
    await bootstrapPlayingWithFrame(harness);

    await expect(
      harness.overlayCallbacks.onShare?.({
        premiereId: PREMIERE_ID,
        kind: "timestamp",
        url: `${window.location.origin}/premiere/${PREMIERE_ID}`,
        sequence: 0,
        turn: 0,
      }),
    ).rejects.toMatchObject({ code: "request_failed" });

    expect(createShare).toHaveBeenCalledTimes(1);
    expect(harness.copyText).not.toHaveBeenCalled();
    expect(harness.models.at(-1)).toMatchObject({
      share: { manualCopyUrl: null, manualCopyReason: null },
      canShare: true,
    });
    harness.runtime.dispose();
  });

  it("does not retain or copy an invalid cross-origin share URL", async () => {
    const createShare = vi.fn(
      async (input: { sequence: number; sourceReactionId?: string | null }) =>
        shareResponse(input, {
          url: `https://attacker.example/premiere/${PREMIERE_ID}?moment=share_${"8".repeat(32)}&attribution=${"a".repeat(16)}.${"b".repeat(16)}`,
        }),
    );
    const harness = runtimeHarness({
      state: "playing",
      service: { createShare },
    });
    await bootstrapPlayingWithFrame(harness);

    await expect(
      harness.overlayCallbacks.onShare?.({
        premiereId: PREMIERE_ID,
        kind: "timestamp",
        url: `${window.location.origin}/premiere/${PREMIERE_ID}`,
        sequence: 0,
        turn: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });

    expect(createShare).toHaveBeenCalledTimes(1);
    expect(harness.copyText).not.toHaveBeenCalled();
    expect(harness.models.at(-1)).toMatchObject({
      share: { manualCopyUrl: null, manualCopyReason: null },
      canShare: true,
    });
    harness.runtime.dispose();
  });

  it("restores a same-participant saved-mark anchor without exposing it to another viewer", async () => {
    const anchor = {
      id: `react_${"5".repeat(32)}`,
      kind: "smart" as const,
      sequence: 0,
      turn: 100,
    };
    const sameParticipant = sessionResponseV4("playing");
    sameParticipant.reactionSummary = reactionSummaryWith("smart", 1);
    sameParticipant.latestOwnReaction = anchor;
    const createShare = vi.fn(
      async (input: { sequence: number; sourceReactionId?: string | null }) =>
        shareResponse(input),
    );
    const restored = runtimeHarness({
      state: "playing",
      service: {
        startSession: async () => sameParticipant,
        createShare,
      },
    });
    await bootstrapPlayingWithFrame(restored);

    expect(restored.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      ownMarkerCounts: { smart: 1 },
      markerConfirmation: { kind: "smart", turn: 100 },
      share: {
        sourceReactionId: anchor.id,
        sourceReactionSequence: 0,
        sourceReactionTurn: 100,
        suggestedCaption:
          "replay_premiere.share_caption:title=Alpha vs Beta,turn=100",
      },
    });
    const restoredShare = restored.models.at(-1)?.share;
    await restored.overlayCallbacks.onShare?.({
      premiereId: PREMIERE_ID,
      kind: "timestamp",
      url: restoredShare?.timestampUrl ?? "",
      sequence: restoredShare?.sourceReactionSequence ?? null,
      turn: restoredShare?.sourceReactionTurn ?? null,
      sourceReactionId: restoredShare?.sourceReactionId,
    });
    const url = shareResponse({
      sequence: anchor.sequence,
      sourceReactionId: anchor.id,
    }).url;
    expect(createShare).toHaveBeenCalledTimes(1);
    expect(createShare).toHaveBeenCalledWith({
      sequence: anchor.sequence,
      sourceReactionId: anchor.id,
    });
    expect(restored.copyText).toHaveBeenCalledTimes(1);
    expect(restored.copyText).toHaveBeenCalledWith(url);
    expect(restored.models.at(-1)?.share?.manualCopyUrl).toBeNull();
    restored.runtime.dispose();

    const otherParticipant = sessionResponseV4("playing");
    otherParticipant.session = viewerSession({
      id: OTHER_SESSION_ID,
      participantId: OTHER_PARTICIPANT_ID,
    });
    otherParticipant.reactionSummary = reactionSummaryWith("smart", 1);
    otherParticipant.reactionSummary.ownByKind = {
      ...emptyReactionSummary().byKind,
    };
    otherParticipant.latestOwnReaction = null;
    const privateViewer = runtimeHarness({
      state: "playing",
      service: { startSession: async () => otherParticipant },
    });
    await bootstrapPlayingWithFrame(privateViewer);

    expect(privateViewer.models.at(-1)).toMatchObject({
      markerCounts: { smart: 1 },
      ownMarkerCounts: { smart: 0 },
      markerConfirmation: null,
      share: {
        sourceReactionId: null,
        sourceReactionSequence: null,
        sourceReactionTurn: null,
      },
    });
    privateViewer.runtime.dispose();
  });

  it("derives a real post-reveal prediction verdict without a seeded resolution", async () => {
    const interaction = sessionResponse("playing");
    interaction.checkpoints[0] = {
      ...checkpoint("cp_12345678", 10),
      state: "closed",
      optionSeatIds: ["seat_a", "seat_b"],
      participantPrediction: {
        premiereId: PREMIERE_ID,
        checkpointId: "cp_12345678",
        participantId: PARTICIPANT_ID,
        selectedSeatId: "seat_a",
        submittedAt: STARTED_AT,
        lockedAt: STARTED_AT,
      },
      distribution: { seat_a: 1, seat_b: 0 },
      totalPredictions: 1,
    };
    const harness = runtimeHarness({
      state: "playing",
      service: { startSession: async () => interaction },
    });
    await bootstrapPlayingWithFrame(harness);
    await revealAfter(harness);

    expect(
      harness.models.at(-1)?.reveal?.results?.predictions[0],
    ).toMatchObject({
      selectedSeatId: "seat_a",
      correctPercent: 100,
      accuracyStatus: "scored",
      totalPredictions: 1,
    });
    harness.runtime.dispose();
  });

  it("keeps a real winner with zero live votes distinct from a void result", async () => {
    const interaction = sessionResponse("playing");
    interaction.checkpoints[0] = {
      ...checkpoint("cp_12345678", 10),
      state: "closed",
      optionSeatIds: ["seat_a", "seat_b"],
      distribution: { seat_a: 0, seat_b: 0 },
      totalPredictions: 0,
    };
    const harness = runtimeHarness({
      state: "playing",
      service: { startSession: async () => interaction },
    });
    await bootstrapPlayingWithFrame(harness);
    await revealAfter(harness);

    expect(
      harness.models.at(-1)?.reveal?.results?.predictions[0],
    ).toMatchObject({
      accuracyStatus: "no_predictions",
      correctPercent: null,
      totalPredictions: 0,
    });
    harness.runtime.dispose();
  });

  it("drives the live-join veil: syncing progress toward the trailed target, complete on arrival", async () => {
    const harness = runtimeHarness({ state: "playing" });
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await started;

    // Released backlog (a mid-show join) + the network's trailed catch-up.
    const records = Array.from({ length: 12 }, (_, sequence) => ({
      sequence,
      presentationOffsetMs: sequence * 100,
      turn: { turnNumber: sequence, intents: [] },
    }));
    harness.runtime.playback.appendVerifiedBatch({
      premiereId: PREMIERE_ID,
      chunkIndex: 0,
      chunkHash: HASH_A,
      previousChunkHash: null,
      payloadHash: HASH_B,
      startSequence: 0,
      endSequence: 11,
      verification: { payloadHashVerified: true, chunkHashVerified: true },
      records,
    });
    harness.runtime.playback.requestForwardCatchUp(8);
    expect(harness.onJoinSync).toHaveBeenCalledWith({
      state: "syncing",
      currentTurn: null,
      targetTurn: 8,
    });

    // Catch-up frames advance the veil progress; the entry frame settles it.
    for (const record of records.slice(0, 9)) {
      harness.runtime.playback.acknowledgeDispatchedRecord(record);
    }
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 5, turnNumber: 5, players: [] },
      }),
    );
    expect(harness.onJoinSync).toHaveBeenCalledWith({
      state: "syncing",
      currentTurn: 5,
      targetTurn: 8,
    });
    expect(harness.onJoinSync).not.toHaveBeenCalledWith({ state: "complete" });

    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 8, turnNumber: 8, players: [] },
      }),
    );
    expect(harness.onJoinSync).toHaveBeenCalledWith({ state: "complete" });

    // Later catch-ups are mid-watch gap recovery: never re-veiled.
    const completeCalls = harness.onJoinSync.mock.calls.length;
    harness.runtime.playback.requestForwardCatchUp(11);
    expect(
      harness.onJoinSync.mock.calls
        .slice(completeCalls)
        .filter(([update]) => update.state === "syncing"),
    ).toEqual([]);
    harness.runtime.dispose();
  });

  it("settles the join veil on the first frame when no catch-up is needed", async () => {
    const harness = runtimeHarness({ state: "playing" });
    await bootstrapPlayingWithFrame(harness);
    expect(harness.onJoinSync).toHaveBeenCalledWith({ state: "complete" });
    expect(
      harness.onJoinSync.mock.calls.filter(
        ([update]) => update.state === "syncing",
      ),
    ).toEqual([]);
    harness.runtime.dispose();
  });

  it("holds the join veil on an early frame when a catch-up is imminent", async () => {
    // Released stream far ahead of the first rendered frame (more than the
    // catch-up threshold in records at 2x): the network will request catch-up
    // on its next manifest, so the first frame must NOT settle the veil into
    // the pre-teleport view.
    const harness = runtimeHarness({ state: "playing" });
    const started = harness.runtime.start();
    await harness.callbacks.onReady?.(projection("playing"));
    await started;
    const records = Array.from({ length: 4_096 }, (_, sequence) => ({
      sequence,
      presentationOffsetMs: sequence * 50,
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
      verification: { payloadHashVerified: true, chunkHashVerified: true },
      records,
    });
    harness.runtime.playback.acknowledgeDispatchedRecord(records[0]);
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 0, turnNumber: 0, players: [] },
      }),
    );
    expect(harness.onJoinSync).not.toHaveBeenCalledWith({ state: "complete" });
    expect(harness.onJoinSync).toHaveBeenCalledWith({
      state: "syncing",
      currentTurn: 0,
      targetTurn: 4_095,
    });
    harness.runtime.dispose();
  });

  it("surfaces buffering only after the display grace and clears it immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT));
    const harness = runtimeHarness({ state: "playing" });
    await bootstrapPlayingWithFrame(harness);

    harness.runtime.playback.reportDispatchStarvation(true);
    expect(harness.models.at(-1)?.buffering ?? false).toBe(false);
    // Sub-grace jitter (a chunk boundary) never shows the chip.
    await vi.advanceTimersByTimeAsync(800);
    harness.runtime.playback.reportDispatchStarvation(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.models.at(-1)?.buffering ?? false).toBe(false);

    // A real stall outlives the grace and surfaces.
    harness.runtime.playback.reportDispatchStarvation(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(harness.models.at(-1)?.buffering).toBe(true);
    // Resume clears instantly.
    harness.runtime.playback.reportDispatchStarvation(false);
    expect(harness.models.at(-1)?.buffering).toBe(false);
    harness.runtime.dispose();
  });

  it("defers a live-watch reveal until the viewer's frame reaches the released end", async () => {
    // Real-speed pacing: the map trails the release clock by up to one chunk
    // span, so a reveal landing mid-trail must NOT name the winner while the
    // ending is still playing. The overlay stays on the live surface (with
    // the quiet reveal-pending status) until the viewer's own rendered frame
    // reaches everything released, then the payoff lands.
    const harness = runtimeHarness({ state: "playing" });
    await bootstrapPlayingWithFrame(harness);
    const trailing = [
      {
        sequence: 1,
        presentationOffsetMs: 100,
        turn: { turnNumber: 1, intents: [] },
      },
      {
        sequence: 2,
        presentationOffsetMs: 200,
        turn: { turnNumber: 2, intents: [] },
      },
    ];
    harness.runtime.playback.appendVerifiedBatch({
      premiereId: PREMIERE_ID,
      chunkIndex: 1,
      chunkHash: HASH_B,
      previousChunkHash: HASH_A,
      payloadHash: HASH_C,
      startSequence: 1,
      endSequence: 2,
      verification: { payloadHashVerified: true, chunkHashVerified: true },
      records: trailing,
    });
    for (const record of trailing) {
      harness.runtime.playback.acknowledgeDispatchedRecord(record);
    }

    // Viewer observed sequence 0; released through 2 -> reveal is deferred.
    await revealAfter(harness);
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      reveal: null,
      revealPending: true,
    });
    expect(document.body.classList.contains("replay-premiere-pre-reveal")).toBe(
      true,
    );

    // Still one sequence behind: stays deferred.
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 1, turnNumber: 1, players: [] },
      }),
    );
    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      reveal: null,
    });

    // Caught up: the reveal displays and host suppression lifts.
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { sequence: 2, turnNumber: 2, players: [] },
      }),
    );
    expect(harness.models.at(-1)).toMatchObject({
      state: "revealed",
      revealPending: false,
    });
    expect(harness.models.at(-1)?.reveal).not.toBeNull();
    expect(document.body.classList.contains("replay-premiere-pre-reveal")).toBe(
      false,
    );
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

  describe("wagering premiere reveal-delivery race (natural end, checkpoint pauses bypassed)", () => {
    function resolvedCheckpoint(): ReplayPremiereServiceCheckpoint {
      return {
        ...checkpoint("cp_12345678", 10),
        resolution: {
          kind: "winner",
          winnerSeatId: "seat_a",
          resolvedAt: STARTED_AT,
        },
      };
    }

    it("does not latch a false integrity failure when a heartbeat reports the match's outcome before the verified reveal has landed", async () => {
      vi.useFakeTimers();
      const harness = runtimeHarness({
        state: "playing",
        service: {
          heartbeat: vi.fn(
            async (): Promise<ReplayPremiereServiceHeartbeatResponse> => ({
              ...heartbeatResponse("revealed"),
              checkpoints: [resolvedCheckpoint(), checkpoint("cp_abcdef12", 20)],
            }),
          ),
        },
      });
      const started = harness.runtime.start();
      await harness.callbacks.onReady?.(projection("playing"));
      await started;

      // The content-tap's own network state races ahead to "revealed"
      // (checkpoint pauses are bypassed for wagering premieres, so there is
      // no final-checkpoint breathing room) while the verified reveal fetch
      // is still in flight — `isRevealVerificationPending()` becomes true.
      await harness.callbacks.onManifest?.(revealedPointer());
      await vi.advanceTimersByTimeAsync(10_000);

      expect(harness.service.heartbeat).toHaveBeenCalledOnce();
      expect(harness.models.at(-1)).toMatchObject({ failureCode: null });
      expect(harness.models.at(-1)?.state).not.toBe("failed");
      expect(harness.network.dispose).not.toHaveBeenCalled();
      expect(harness.service.dispose).not.toHaveBeenCalled();

      // The reveal lands shortly after — the premiere reaches `revealed`
      // cleanly, exactly as if the race had never happened.
      await harness.callbacks.onReveal?.(verifiedReveal());
      await harness.callbacks.onTerminal?.("revealed");
      expect(harness.models.at(-1)).toMatchObject({
        state: "revealed",
        failureCode: null,
      });
      harness.runtime.dispose();
    });

    it("still latches a genuine integrity failure when a heartbeat reports the match's outcome and the replay's own state machine cannot explain it", async () => {
      vi.useFakeTimers();
      const harness = runtimeHarness({
        state: "playing",
        service: {
          heartbeat: vi.fn(
            async (): Promise<ReplayPremiereServiceHeartbeatResponse> => ({
              ...heartbeatResponse("playing"),
              checkpoints: [resolvedCheckpoint(), checkpoint("cp_abcdef12", 20)],
            }),
          ),
        },
      });
      const started = harness.runtime.start();
      await harness.callbacks.onReady?.(projection("playing"));
      await started;

      // No reveal pointer, no terminal signal — the network layer still
      // thinks this premiere is plainly "playing". A heartbeat claiming an
      // outcome-bearing checkpoint here is not explicable by any pending
      // reveal; it must still latch.
      await vi.advanceTimersByTimeAsync(10_000);

      expect(harness.models.at(-1)).toMatchObject({
        state: "failed",
        failureCode: "integrity_failure",
      });
      expect(harness.network.dispose).toHaveBeenCalled();
      expect(harness.service.dispose).toHaveBeenCalled();
      harness.runtime.dispose();
    });
  });

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

  it("shows clip generation during playing when the current released range is renderable", async () => {
    const harness = runtimeHarness({ state: "playing" });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();

    const playing = harness.models.at(-1);
    expect(playing?.state).toBe("playing");
    expect(playing?.clip).toEqual({ status: "idle", ready: null });
    expect(playing?.canRequestClip).toBe(true);
    harness.runtime.dispose();
  });

  it("hides generation until an incomplete source proves the full capture tail", async () => {
    vi.useFakeTimers();
    const initial = sessionResponse("playing");
    initial.clipEligibility = clipEligibility({ renderableThroughTurn: 214 });
    const expanded = heartbeatResponse("checkpoint");
    expanded.clipEligibility = clipEligibility({ renderableThroughTurn: 215 });
    const harness = runtimeHarness({
      state: "playing",
      service: {
        startSession: async () => initial,
        heartbeat: async () => expanded,
      },
    });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();
    expect(harness.models.at(-1)).toMatchObject({
      clip: null,
      canRequestClip: false,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.models.at(-1)).toMatchObject({
      state: "checkpoint",
      clip: { status: "idle", ready: null },
      canRequestClip: true,
    });
    harness.runtime.dispose();
  });

  it("uses source completeness rather than lifecycle state for terminal clip shifting", async () => {
    const complete = sessionResponse("playing");
    complete.clipEligibility = clipEligibility({
      renderableThroughTurn: 65,
      sourceComplete: true,
    });
    const harness = runtimeHarness({
      state: "playing",
      service: { startSession: async () => complete },
    });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();

    expect(harness.models.at(-1)).toMatchObject({
      state: "playing",
      clip: { status: "idle", ready: null },
      canRequestClip: true,
    });
    harness.runtime.dispose();
  });

  it("keeps the live clip block absent and rejects generation when the process capability is off", async () => {
    const harness = runtimeHarness({
      state: "playing",
      clipCapabilities: async () => ({
        schemaVersion: 1,
        premiereGenerationEnabled: false,
        leagueGenerationEnabled: false,
      }),
    });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();
    await revealAfter(harness);
    await vi.waitFor(() => {
      expect(harness.models.at(-1)).toMatchObject({
        clip: null,
        canRequestClip: false,
        clipMarkerAvailable: false,
      });
    });

    await expect(
      harness.overlayCallbacks.onRequestClip?.({
        premiereId: PREMIERE_ID,
        sequence: 0,
        turn: 0,
      }),
    ).rejects.toMatchObject({ code: "request_rejected" });
    expect(harness.service.requestClip).not.toHaveBeenCalled();
    harness.runtime.dispose();
  });

  it("renders a downloadable clip after a pending render is polled to ready", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT));
    const readClipStatus = vi
      .fn<(bucket: number) => Promise<ReplayPremiereClipStatusResponse>>()
      .mockResolvedValueOnce(clipStatus("pending"))
      .mockResolvedValueOnce(clipStatus("ready"));
    const harness = runtimeHarness({
      state: "playing",
      service: {
        requestClip: async () => clipStatus("pending"),
        readClipStatus,
      },
    });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();
    await revealAfter(harness);

    await harness.overlayCallbacks.onRequestClip?.({
      premiereId: PREMIERE_ID,
      sequence: 0,
      turn: 0,
    });
    expect(harness.service.requestClip).toHaveBeenCalledWith({
      sequence: 0,
      turn: 60,
    });
    expect(harness.models.at(-1)?.clip).toEqual({
      status: "preparing",
      ready: null,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(readClipStatus).toHaveBeenCalledWith(6);
    expect(harness.models.at(-1)?.clip?.status).toBe("preparing");
    await vi.advanceTimersByTimeAsync(2_250);

    expect(readClipStatus).toHaveBeenCalledTimes(2);
    expect(harness.models.at(-1)?.clip).toEqual({
      status: "ready",
      ready: { downloadUrl: `/premiere/${PREMIERE_ID}/clip-v1-6.mp4` },
    });
    harness.runtime.dispose();
  });

  it("surfaces a busy clip status without hanging when the render service is at capacity", async () => {
    const harness = runtimeHarness({
      state: "playing",
      service: {
        requestClip: async () => {
          throw new ReplayPremiereServiceError(
            "request_rejected",
            429,
            "PREMIERE_CAPACITY_EXCEEDED",
            "response_status",
          );
        },
      },
    });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();
    await revealAfter(harness);

    await expect(
      harness.overlayCallbacks.onRequestClip?.({
        premiereId: PREMIERE_ID,
        sequence: 0,
        turn: 0,
      }),
    ).resolves.toBeUndefined();

    expect(harness.service.readClipStatus).not.toHaveBeenCalled();
    expect(harness.models.at(-1)?.clip?.status).toBe("busy");
    expect(harness.models.at(-1)?.failureCode).toBeNull();
    harness.runtime.dispose();
  });

  it("ends in a terminal failed clip status when a pending render is evicted (404)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT));
    const readClipStatus = vi
      .fn<(bucket: number) => Promise<ReplayPremiereClipStatusResponse>>()
      .mockRejectedValue(
        new ReplayPremiereServiceError(
          "request_rejected",
          404,
          "PREMIERE_UNAVAILABLE",
          "response_status",
        ),
      );
    const harness = runtimeHarness({
      state: "playing",
      service: {
        requestClip: async () => clipStatus("pending"),
        readClipStatus,
      },
    });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();
    await revealAfter(harness);
    await harness.overlayCallbacks.onRequestClip?.({
      premiereId: PREMIERE_ID,
      sequence: 0,
      turn: 0,
    });
    await vi.advanceTimersByTimeAsync(1_500);

    expect(readClipStatus).toHaveBeenCalledOnce();
    expect(harness.models.at(-1)?.clip?.status).toBe("failed");
    // No further polls scheduled: advancing well past the cap adds no calls.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readClipStatus).toHaveBeenCalledOnce();
    harness.runtime.dispose();
  });

  it("bounds the clip poll loop and fails closed instead of polling forever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT));
    const readClipStatus = vi
      .fn<(bucket: number) => Promise<ReplayPremiereClipStatusResponse>>()
      .mockResolvedValue(clipStatus("pending"));
    const harness = runtimeHarness({
      state: "playing",
      service: {
        // Post-reveal heartbeats report the revealed lifecycle (as the server
        // does); the default harness heartbeat reports "playing".
        heartbeat: async () => heartbeatResponse("revealed"),
        requestClip: async () => clipStatus("pending"),
        readClipStatus,
      },
    });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();
    await revealAfter(harness);
    await harness.overlayCallbacks.onRequestClip?.({
      premiereId: PREMIERE_ID,
      sequence: 0,
      turn: 0,
    });

    await vi.advanceTimersByTimeAsync(200_000);
    expect(harness.models.at(-1)?.clip?.status).toBe("failed");
    expect(readClipStatus.mock.calls.length).toBeLessThanOrEqual(20);
    const settledCalls = readClipStatus.mock.calls.length;
    // The loop is terminated: no timer keeps firing after the cap.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(readClipStatus.mock.calls.length).toBe(settledCalls);
    harness.runtime.dispose();
  });

  it("copies the clip caption and reply verbatim with the deep link only in the reply", async () => {
    const harness = runtimeHarness({
      state: "playing",
      service: {
        requestClip: async () => clipStatus("ready"),
      },
    });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();
    await revealAfter(harness);
    await harness.overlayCallbacks.onRequestClip?.({
      premiereId: PREMIERE_ID,
      sequence: 0,
      turn: 0,
    });
    expect(harness.models.at(-1)?.clip).toEqual({
      status: "ready",
      ready: { downloadUrl: `/premiere/${PREMIERE_ID}/clip-v1-6.mp4` },
    });

    await harness.overlayCallbacks.onCopyClipText?.({
      premiereId: PREMIERE_ID,
      part: "caption",
    });
    await harness.overlayCallbacks.onCopyClipText?.({
      premiereId: PREMIERE_ID,
      part: "reply",
    });

    expect(harness.copyText).toHaveBeenNthCalledWith(1, CLIP_CAPTION);
    expect(harness.copyText).toHaveBeenNthCalledWith(2, CLIP_REPLY);
    expect(CLIP_CAPTION).not.toContain(`/premiere/${PREMIERE_ID}`);
    expect(CLIP_REPLY).toContain(`/premiere/${PREMIERE_ID}`);
    harness.runtime.dispose();
  });

  it("keeps every clip affordance and write disabled when the server capability is off", async () => {
    const disabledSession = sessionResponse("playing");
    disabledSession.clipsEnabled = false;
    disabledSession.clipEligibility = clipEligibility({
      generationEnabled: false,
      renderableThroughTurn: null,
    });
    const harness = runtimeHarness({
      state: "playing",
      service: { startSession: async () => disabledSession },
    });
    await bootstrapPlayingWithFrame(harness);
    renderClipEligibleFrame();
    await revealAfter(harness);

    expect(harness.models.at(-1)).toMatchObject({
      clip: null,
      canRequestClip: false,
      clipMarkerAvailable: false,
    });
    await expect(
      harness.overlayCallbacks.onRequestClip?.({
        premiereId: PREMIERE_ID,
        sequence: 0,
        turn: 0,
      }),
    ).rejects.toMatchObject({ code: "request_rejected" });
    expect(harness.service.requestClip).not.toHaveBeenCalled();
    harness.runtime.dispose();
  });
});

describe("ReplayPremiereServiceClient", () => {
  it("ignores ordered stale aggregates but rejects inconsistent/incomparable evidence and capability drift", async () => {
    const inconsistent = sessionResponse("playing");
    inconsistent.reactionSummary = {
      ...reactionSummaryWith("smart", 1),
      totalReactions: 2,
    };
    const seeded = sessionResponse("playing");
    seeded.reactionSummary = reactionSummaryWith("smart", 2);
    const stale = heartbeatResponse("playing");
    stale.reactionSummary = reactionSummaryWith("smart", 1);
    const incomparable = heartbeatResponse("playing");
    incomparable.reactionSummary = reactionSummaryWith("betrayal", 1);
    const capabilityFlip = heartbeatResponse("playing");
    capabilityFlip.reactionSummary = reactionSummaryWith("smart", 2);
    capabilityFlip.clipsEnabled = false;
    capabilityFlip.clipEligibility = clipEligibility({
      generationEnabled: false,
      renderableThroughTurn: null,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(inconsistent, 201))
      .mockResolvedValueOnce(jsonResponse(seeded, 201))
      .mockResolvedValueOnce(jsonResponse(stale, 200))
      .mockResolvedValueOnce(jsonResponse(incomparable, 200))
      .mockResolvedValueOnce(jsonResponse(capabilityFlip, 200));
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
      phase: "response_binding",
    });
    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).resolves.toMatchObject({ reactionSummary: { totalReactions: 2 } });
    await expect(
      client.heartbeat({ visible: true, observedSequence: -1 }),
    ).resolves.toMatchObject({ reactionSummary: { totalReactions: 1 } });
    await expect(
      client.heartbeat({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      client.heartbeat({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    client.dispose();
  });

  it("accepts concurrent reaction responses in reverse arrival order without regressing state", async () => {
    const olderResponse = deferred<Response>();
    const newerResponse = deferred<Response>();
    const newerSummary = reactionSummaryWith("smart", 1);
    newerSummary.totalReactions = 2;
    newerSummary.byKind.betrayal = 1;
    newerSummary.ownByKind!.betrayal = 1;
    const older = reactionResponse();
    const newer: ReplayPremiereServiceReactionResponse = {
      ...reactionResponse(),
      reaction: {
        ...reactionResponse().reaction,
        id: `react_${"8".repeat(32)}`,
        sequence: 1,
        kind: "betrayal",
      },
      reactionSummary: newerSummary,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(sessionResponse("playing"), 201))
      .mockImplementationOnce(() => olderResponse.promise)
      .mockImplementationOnce(() => newerResponse.promise);
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));
    await client.startSession({ visible: true, observedSequence: -1 });

    const olderWrite = client.submitReaction({
      premiereId: PREMIERE_ID,
      kind: "smart",
      sequence: 0,
      turn: 0,
      policySeatId: null,
    });
    const newerWrite = client.submitReaction({
      premiereId: PREMIERE_ID,
      kind: "betrayal",
      sequence: 1,
      turn: 1,
      policySeatId: null,
    });
    newerResponse.resolve(jsonResponse(newer, 200));
    await expect(newerWrite).resolves.toMatchObject({
      reactionSummary: { totalReactions: 2 },
    });
    olderResponse.resolve(jsonResponse(older, 200));
    await expect(olderWrite).resolves.toMatchObject({
      reactionSummary: { totalReactions: 1 },
    });
    client.dispose();
  });

  it("normalizes exact v1 fallback responses and accepts a later negotiated v2 upgrade", async () => {
    const upgradedHeartbeat = heartbeatResponse("playing");
    upgradedHeartbeat.reactionSummary = reactionSummaryWith("smart", 1);
    upgradedHeartbeat.clipsEnabled = false;
    upgradedHeartbeat.clipEligibility = clipEligibility({
      generationEnabled: false,
      renderableThroughTurn: null,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(legacySessionResponseRaw("playing"), 201),
      )
      .mockResolvedValueOnce(jsonResponse(legacyReactionResponseRaw(), 200))
      .mockResolvedValueOnce(jsonResponse(upgradedHeartbeat, 200));
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      reactionSummary: null,
      clipsEnabled: null,
      clipEligibility: null,
    });
    await expect(
      client.submitReaction({
        premiereId: PREMIERE_ID,
        kind: "smart",
        sequence: 0,
        turn: 0,
        policySeatId: null,
      }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      reactionSummary: null,
      clipsEnabled: null,
      clipEligibility: null,
    });
    await expect(
      client.heartbeat({ visible: true, observedSequence: 0 }),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      reactionSummary: { totalReactions: 1 },
      clipsEnabled: false,
      clipEligibility: { generationEnabled: false },
    });
    for (const [, request] of fetchMock.mock.calls) {
      expect(
        new Headers(request?.headers).get("x-proxywar-premiere-interactions"),
      ).toBe("4");
    }
    client.dispose();
  });

  it("accepts frozen v3 responses without clip eligibility and keeps clips fail closed", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(frozenV3SessionResponseRaw("playing"), 201),
      )
      .mockResolvedValueOnce(
        jsonResponse(frozenV3HeartbeatResponseRaw("playing"), 200),
      )
      .mockResolvedValueOnce(jsonResponse(frozenV3ReactionResponseRaw(), 200));
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).resolves.toMatchObject({
      schemaVersion: 3,
      clipsEnabled: true,
      clipEligibility: null,
      latestOwnReaction: null,
    });
    await expect(
      client.heartbeat({ visible: true, observedSequence: 0 }),
    ).resolves.toMatchObject({
      schemaVersion: 3,
      clipsEnabled: true,
      clipEligibility: null,
      latestOwnReaction: null,
    });
    await expect(
      client.submitReaction({
        premiereId: PREMIERE_ID,
        kind: "smart",
        sequence: 0,
        turn: 0,
        policySeatId: null,
      }),
    ).resolves.toMatchObject({
      schemaVersion: 3,
      clipsEnabled: true,
      clipEligibility: null,
      latestOwnReaction: { kind: "smart", sequence: 0, turn: 0 },
    });
    for (const [, request] of fetchMock.mock.calls) {
      expect(
        new Headers(request?.headers).get("x-proxywar-premiere-interactions"),
      ).toBe("4");
    }
    client.dispose();
  });

  it("rejects a v4 private anchor not proven by the requesting participant's counts", async () => {
    const leaked = sessionResponseV4("playing");
    leaked.reactionSummary = reactionSummaryWith("smart", 1);
    leaked.reactionSummary.ownByKind = { ...emptyReactionSummary().byKind };
    leaked.latestOwnReaction = {
      id: `react_${"4".repeat(32)}`,
      kind: "smart",
      sequence: 0,
      turn: 100,
    };
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: vi.fn(async () => jsonResponse(leaked, 201)),
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      phase: "response_binding",
    });
    client.dispose();
  });

  it("invalidates v2 capability across exact-v1 session, heartbeat, and reaction fallback", async () => {
    const initial = sessionResponse("playing");
    initial.reactionSummary = reactionSummaryWith("smart", 1);
    initial.clipsEnabled = true;
    const upgraded = heartbeatResponse("playing");
    upgraded.reactionSummary = reactionSummaryWith("smart", 2);
    upgraded.clipsEnabled = false;
    upgraded.clipEligibility = clipEligibility({
      generationEnabled: false,
      renderableThroughTurn: null,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(initial, 201))
      .mockResolvedValueOnce(
        jsonResponse(legacySessionResponseRaw("playing"), 201),
      )
      .mockResolvedValueOnce(
        jsonResponse(legacyHeartbeatResponseRaw("playing"), 200),
      )
      .mockResolvedValueOnce(jsonResponse(legacyReactionResponseRaw(), 200))
      .mockResolvedValueOnce(jsonResponse(upgraded, 200));
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));

    await client.startSession({ visible: true, observedSequence: -1 });
    await expect(
      client.startSession({ visible: true, observedSequence: -1 }),
    ).resolves.toMatchObject({
      reactionSummary: null,
      clipsEnabled: null,
      clipEligibility: null,
    });
    await expect(
      client.heartbeat({ visible: true, observedSequence: 0 }),
    ).resolves.toMatchObject({
      reactionSummary: null,
      clipsEnabled: null,
      clipEligibility: null,
    });
    await expect(
      client.submitReaction({
        premiereId: PREMIERE_ID,
        kind: "smart",
        sequence: 0,
        turn: 0,
        policySeatId: null,
      }),
    ).resolves.toMatchObject({
      reactionSummary: null,
      clipsEnabled: null,
      clipEligibility: null,
    });
    await expect(
      client.heartbeat({ visible: true, observedSequence: 0 }),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      reactionSummary: { totalReactions: 2 },
      clipsEnabled: false,
      clipEligibility: { generationEnabled: false },
    });
    client.dispose();
  });

  it("resets the private reaction baseline and semantic keys when guest identity rotates", async () => {
    const initial = sessionResponse("playing");
    const firstReaction = reactionResponse();
    const recovered = sessionResponse("playing");
    recovered.session = viewerSession({
      id: OTHER_SESSION_ID,
      participantId: OTHER_PARTICIPANT_ID,
    });
    recovered.reactionSummary = reactionSummaryWith("smart", 1);
    recovered.reactionSummary.ownByKind = { ...emptyReactionSummary().byKind };
    const secondReaction: ReplayPremiereServiceReactionResponse = {
      ...reactionResponse(),
      reaction: {
        ...reactionResponse().reaction,
        id: `react_${"8".repeat(32)}`,
        participantId: OTHER_PARTICIPANT_ID,
      },
      reactionSummary: reactionSummaryWith("smart", 2),
    };
    secondReaction.reactionSummary!.ownByKind = {
      ...emptyReactionSummary().byKind,
      smart: 1,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(initial, 201))
      .mockResolvedValueOnce(jsonResponse(firstReaction, 200))
      .mockResolvedValueOnce(jsonResponse(recovered, 201))
      .mockResolvedValueOnce(jsonResponse(secondReaction, 200));
    let randomByte = 1;
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(randomByte++),
    });
    client.bindVerifiedProjection(projection("playing"));
    const input = {
      premiereId: PREMIERE_ID,
      kind: "smart" as const,
      sequence: 0,
      turn: 0,
      policySeatId: null,
    };

    await client.startSession({ visible: true, observedSequence: -1 });
    await expect(client.submitReaction(input)).resolves.toMatchObject({
      reaction: { participantId: PARTICIPANT_ID },
    });
    await client.startSession({ visible: true, observedSequence: -1 });
    await expect(client.submitReaction(input)).resolves.toMatchObject({
      reaction: { participantId: OTHER_PARTICIPANT_ID },
      reactionSummary: { ownByKind: { smart: 1 } },
    });
    const firstKey = new Headers(fetchMock.mock.calls[1][1]?.headers).get(
      "x-idempotency-key",
    );
    const secondKey = new Headers(fetchMock.mock.calls[3][1]?.headers).get(
      "x-idempotency-key",
    );
    expect(firstKey).not.toBe(secondKey);
    client.dispose();
  });

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
    expect(
      new Headers(firstSessionRequest?.headers).get(
        "x-proxywar-premiere-interactions",
      ),
    ).toBe("4");

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
    expect(
      new Headers(firstHeartbeatRequest?.headers).get(
        "x-proxywar-premiere-interactions",
      ),
    ).toBe("4");

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
    expect(
      new Headers(firstReactionRequest?.headers).get(
        "x-proxywar-premiere-interactions",
      ),
    ).toBe("4");
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

  it("posts a clip anchor with the csrf and idempotency envelope and returns pending", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(sessionResponse("playing"), 201))
      .mockResolvedValueOnce(jsonResponse(clipStatus("pending", 6), 200));
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    client.bindVerifiedProjection(projection("playing"));
    await client.startSession({ visible: true, observedSequence: -1 });

    const status = await client.requestClip({ sequence: 60, turn: 60 });
    expect(status.state).toBe("pending");
    expect(status.bucket).toBe(6);

    const clipCall = fetchMock.mock.calls[1];
    expect(clipCall[0]).toBe(`/api/premieres/${PREMIERE_ID}/clips`);
    expect(clipCall[1]?.method).toBe("POST");
    expect(clipCall[1]?.credentials).toBe("same-origin");
    expect(JSON.parse(String(clipCall[1]?.body))).toEqual({
      sequence: 60,
      turn: 60,
    });
    const headers = new Headers(clipCall[1]?.headers);
    expect(headers.get("x-csrf-token")).toBe(CSRF_TOKEN);
    expect(headers.get("x-idempotency-key")).toMatch(/^idem_[0-9a-f]{32}$/);
    client.dispose();
  });

  it("reads a ready clip status by bucket with verbatim social text over GET", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(clipStatus("ready", 6), 200));
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: fetchMock,
      randomBytes: () => new Uint8Array(16).fill(1),
    });

    const status = await client.readClipStatus(6);
    expect(status.state).toBe("ready");
    expect(status.ready?.clipUrl).toBe(
      `/premiere/${PREMIERE_ID}/clip-v1-6.mp4`,
    );
    expect(status.ready?.social.caption).toBe(CLIP_CAPTION);
    expect(status.ready?.social.firstReply).toBe(CLIP_REPLY);

    const readCall = fetchMock.mock.calls[0];
    expect(readCall[0]).toBe(`/api/premieres/${PREMIERE_ID}/clips/6`);
    expect(readCall[1]?.method).toBe("GET");
    expect(readCall[1]?.body).toBeUndefined();
    client.dispose();
  });

  it.each([
    [429, "PREMIERE_CAPACITY_EXCEEDED"],
    [503, "PREMIERE_UNAVAILABLE"],
  ])(
    "rejects a %i clip render as a typed capacity error without hanging",
    async (httpStatus, publicCode) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(sessionResponse("playing"), 201))
        .mockResolvedValueOnce(
          jsonResponse({ error: { code: publicCode } }, httpStatus),
        );
      const client = new ReplayPremiereServiceClient({
        premiereId: PREMIERE_ID,
        origin: "https://proxywar.example",
        fetchImpl: fetchMock,
        randomBytes: () => new Uint8Array(16).fill(1),
      });
      client.bindVerifiedProjection(projection("playing"));
      await client.startSession({ visible: true, observedSequence: -1 });

      await expect(
        client.requestClip({ sequence: 60, turn: 60 }),
      ).rejects.toMatchObject({
        code: "request_rejected",
        status: httpStatus,
        publicCode,
      });
      client.dispose();
    },
  );

  it("classifies a malformed gateway clip-status read as retryable transport", async () => {
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: vi.fn(async () => malformedGatewayResponse(503)),
      randomBytes: () => new Uint8Array(16).fill(1),
    });

    await expect(client.readClipStatus(6)).rejects.toMatchObject({
      code: "request_failed",
      status: 503,
      phase: "response_status",
    });
    client.dispose();
  });

  it("rejects clip social text that leaks the deep link into the caption", async () => {
    const leaked = clipStatus("ready", 6);
    leaked.ready!.social.caption = `Spoiler: /premiere/${PREMIERE_ID} winner`;
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: vi.fn(async () => jsonResponse(leaked, 200)),
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    await expect(client.readClipStatus(6)).rejects.toMatchObject({
      code: "invalid_response",
    });
    client.dispose();
  });

  it("rejects a clip reply that omits the premiere deep link", async () => {
    const missing = clipStatus("ready", 6);
    missing.ready!.social.firstReply = "Watch the full premiere.";
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: vi.fn(async () => jsonResponse(missing, 200)),
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    await expect(client.readClipStatus(6)).rejects.toMatchObject({
      code: "invalid_response",
    });
    client.dispose();
  });

  it("rejects a clip whose file url disagrees with the status bucket", async () => {
    const mismatch = clipStatus("ready", 6);
    mismatch.ready!.clipUrl = `/premiere/${PREMIERE_ID}/clip-v1-7.mp4`;
    const client = new ReplayPremiereServiceClient({
      premiereId: PREMIERE_ID,
      origin: "https://proxywar.example",
      fetchImpl: vi.fn(async () => jsonResponse(mismatch, 200)),
      randomBytes: () => new Uint8Array(16).fill(1),
    });
    await expect(client.readClipStatus(6)).rejects.toMatchObject({
      code: "invalid_response",
    });
    client.dispose();
  });
});

function runtimeHarness(options: {
  state: ReplayPremiereReadyProjection["state"];
  clipCapabilities?: () => Promise<ProxyWarClipGenerationCapabilities>;
  copyText?: (text: string) => Promise<void>;
  useDefaultCopyText?: boolean;
  service?: {
    startSession?: () => Promise<ReplayPremiereServiceSessionResponse>;
    heartbeat?: () => Promise<ReplayPremiereServiceHeartbeatResponse>;
    submitReaction?: () => Promise<ReplayPremiereServiceReactionResponse>;
    createShare?: (input: {
      sequence: number;
      sourceReactionId?: string | null;
    }) => Promise<ReplayPremiereServiceShareResponse>;
    requestClip?: (input: {
      sequence: number;
      turn: number;
    }) => Promise<ReplayPremiereClipStatusResponse>;
    readClipStatus?: (
      bucket: number,
    ) => Promise<ReplayPremiereClipStatusResponse>;
    onBind?: () => void;
  };
  onJoin?: () => void;
  onRevealSeek?: (turn: number) => void;
  onJoinSync?: (update: ReplayPremiereJoinSyncUpdate) => void;
}) {
  let callbacks!: ReplayPremiereNetworkCallbacks;
  let overlayCallbacks!: ReplayPremiereOverlayCallbacks;
  const models: ReplayPremiereOverlayModel[] = [];
  if (options.copyText !== undefined && options.useDefaultCopyText === true) {
    throw new Error("runtimeHarness clipboard configuration is ambiguous");
  }
  const copyText = vi.fn(options.copyText ?? (async () => undefined));
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
    submitMarketOrder: vi.fn(),
    readMarketState: vi.fn(async () => ({
      schemaVersion: 1 as const,
      market: {
        outcomeSeatIds: [],
        q: [],
        b: 1,
        prices: [],
        status: "open" as const,
        winnerSeatId: null,
        liveVisibleSequence: 0,
        positions: null,
        balance: null,
      },
    })),
    readMarketSelf: vi.fn(async () => ({
      schemaVersion: 1 as const,
      market: {
        outcomeSeatIds: [],
        q: [],
        b: 1,
        prices: [],
        status: "open" as const,
        winnerSeatId: null,
        liveVisibleSequence: 0,
        positions: null,
        balance: null,
      },
    })),
    submitReaction:
      options.service?.submitReaction === undefined
        ? vi.fn(
            async (input: {
              kind: string;
              sequence: number;
              turn: number | null;
            }) =>
              ({
                schemaVersion: 2,
                reaction: {
                  id: `react_${"a".repeat(32)}`,
                  premiereId: PREMIERE_ID,
                  participantId: PARTICIPANT_ID,
                  sequence: input.sequence,
                  turn: input.turn ?? 0,
                  kind: input.kind,
                  policyIdentity: null,
                  eventContext: {},
                  createdAt: STARTED_AT,
                },
                idempotent: false,
                reactionSummary: reactionSummaryWith(
                  input.kind as keyof ReplayPremiereServiceReactionSummary["byKind"],
                  1,
                ),
                clipsEnabled: true,
                clipEligibility: clipEligibility(),
              }) as unknown as ReplayPremiereServiceReactionResponse,
          )
        : vi.fn(options.service.submitReaction),
    createShare:
      options.service?.createShare === undefined
        ? vi.fn()
        : vi.fn(options.service.createShare),
    requestClip:
      options.service?.requestClip === undefined
        ? vi.fn(async () => clipStatus("pending"))
        : vi.fn(options.service.requestClip),
    readClipStatus:
      options.service?.readClipStatus === undefined
        ? vi.fn(async () => clipStatus("ready"))
        : vi.fn(options.service.readClipStatus),
    dispose: vi.fn(),
  };
  const onJoin = vi.fn(options.onJoin);
  const onRevealSeek = vi.fn(options.onRevealSeek);
  const onJoinSync = vi.fn(options.onJoinSync);
  const runtime = new ReplayPremiereRuntimeController({
    premiereId: PREMIERE_ID,
    onJoinReady: onJoin,
    onRevealSeek,
    onJoinSync,
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
      ...(options.useDefaultCopyText === true ? {} : { copyText }),
      downloadReminder: vi.fn(),
      readClipGenerationCapabilities:
        options.clipCapabilities ??
        (async () => ({
          schemaVersion: 1,
          premiereGenerationEnabled: true,
          leagueGenerationEnabled: true,
        })),
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
    copyText,
    onJoin,
    onRevealSeek,
    onJoinSync,
  };
}

async function bootstrapPlayingWithFrame(
  harness: ReturnType<typeof runtimeHarness>,
): Promise<void> {
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
    verification: { payloadHashVerified: true, chunkHashVerified: true },
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
}

function renderClipEligibleFrame(turnNumber = 60): void {
  document.dispatchEvent(
    new CustomEvent("ai-league-replay-frame", {
      detail: { sequence: 0, turnNumber, players: [] },
    }),
  );
}

async function revealAfter(
  harness: ReturnType<typeof runtimeHarness>,
): Promise<void> {
  await harness.callbacks.onManifest?.(revealedPointer());
  await harness.callbacks.onReveal?.(verifiedReveal());
  await harness.callbacks.onTerminal?.("revealed");
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
    schemaVersion: 2,
    csrfToken: CSRF_TOKEN,
    session: viewerSession(),
    premiereState,
    checkpoints: [checkpoint("cp_12345678", 10), checkpoint("cp_abcdef12", 20)],
    incomingMoment: null,
    reactionSummary: emptyReactionSummary(),
    clipsEnabled: true,
    clipEligibility: clipEligibility(),
  };
}

function sessionResponseV4(
  premiereState: ReplayPremiereServiceSessionResponse["premiereState"],
): Extract<ReplayPremiereServiceSessionResponse, { schemaVersion: 4 }> {
  const response = sessionResponse(premiereState);
  const eligibility = response.clipEligibility;
  if (response.schemaVersion !== 2 || eligibility === null) {
    throw new Error("test helper expected a v2 session response");
  }
  return {
    ...response,
    schemaVersion: 4,
    latestOwnReaction: null,
    clipEligibility: eligibility,
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
    schemaVersion: 2,
    session: viewerSession(sessionOverrides),
    idempotent: false,
    persisted: false,
    premiereState,
    checkpoints: [checkpoint("cp_12345678", 10), checkpoint("cp_abcdef12", 20)],
    reactionSummary: emptyReactionSummary(),
    clipsEnabled: true,
    clipEligibility: clipEligibility(),
  };
}

function heartbeatResponseV4(
  premiereState: ReplayPremiereServiceHeartbeatResponse["premiereState"],
): Extract<ReplayPremiereServiceHeartbeatResponse, { schemaVersion: 4 }> {
  const response = heartbeatResponse(premiereState);
  const eligibility = response.clipEligibility;
  if (response.schemaVersion !== 2 || eligibility === null) {
    throw new Error("test helper expected a v2 heartbeat response");
  }
  return {
    ...response,
    schemaVersion: 4,
    latestOwnReaction: null,
    clipEligibility: eligibility,
  };
}

function reactionResponse() {
  return {
    schemaVersion: 2 as const,
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
    reactionSummary: reactionSummaryWith("smart", 1),
    clipsEnabled: true,
    clipEligibility: clipEligibility(),
  };
}

function reactionResponseV4(): Extract<
  ReplayPremiereServiceReactionResponse,
  { schemaVersion: 4 }
> {
  const response = reactionResponse();
  return {
    ...response,
    schemaVersion: 4,
    latestOwnReaction: {
      id: response.reaction.id,
      kind: response.reaction.kind,
      sequence: response.reaction.sequence,
      turn: response.reaction.turn,
    },
  };
}

function shareResponse(
  input: { sequence: number; sourceReactionId?: string | null },
  overrides: {
    participantId?: string;
    url?: string;
  } = {},
): ReplayPremiereServiceShareResponse {
  const shareId = `share_${"8".repeat(32)}`;
  const attributionToken = `${"a".repeat(16)}.${"b".repeat(16)}`;
  return {
    schemaVersion: 1,
    share: {
      id: shareId,
      premiereId: PREMIERE_ID,
      sourceReactionId: input.sourceReactionId ?? null,
      sequence: input.sequence,
      turn: 0,
      createdByParticipantId: overrides.participantId ?? PARTICIPANT_ID,
      cardVersion: 1,
      createdAt: STARTED_AT,
      idempotencyKey: `idem_${"9".repeat(32)}`,
    },
    attributionToken,
    url:
      overrides.url ??
      `${window.location.origin}/premiere/${PREMIERE_ID}?moment=${shareId}&attribution=${attributionToken}`,
    idempotent: false,
  };
}

function legacySessionResponseRaw(
  premiereState: ReplayPremiereServiceSessionResponse["premiereState"],
) {
  const current = sessionResponse(premiereState);
  const {
    reactionSummary: _summary,
    clipsEnabled: _clips,
    clipEligibility: _clipEligibility,
    ...legacy
  } = current;
  return { ...legacy, schemaVersion: 1 as const };
}

function frozenV3SessionResponseRaw(
  premiereState: ReplayPremiereServiceSessionResponse["premiereState"],
) {
  const current = sessionResponseV4(premiereState);
  const { clipEligibility: _clipEligibility, ...frozen } = current;
  return { ...frozen, schemaVersion: 3 as const };
}

function legacyReactionResponseRaw() {
  const current = reactionResponse();
  const {
    reactionSummary: _summary,
    clipsEnabled: _clips,
    clipEligibility: _clipEligibility,
    ...legacy
  } = current;
  return { ...legacy, schemaVersion: 1 as const };
}

function frozenV3ReactionResponseRaw() {
  const current = reactionResponseV4();
  const { clipEligibility: _clipEligibility, ...frozen } = current;
  return { ...frozen, schemaVersion: 3 as const };
}

function legacyHeartbeatResponseRaw(
  premiereState: ReplayPremiereServiceHeartbeatResponse["premiereState"],
) {
  const current = heartbeatResponse(premiereState);
  const {
    reactionSummary: _summary,
    clipsEnabled: _clips,
    clipEligibility: _clipEligibility,
    ...legacy
  } = current;
  return { ...legacy, schemaVersion: 1 as const };
}

function frozenV3HeartbeatResponseRaw(
  premiereState: ReplayPremiereServiceHeartbeatResponse["premiereState"],
) {
  const current = heartbeatResponseV4(premiereState);
  const { clipEligibility: _clipEligibility, ...frozen } = current;
  return { ...frozen, schemaVersion: 3 as const };
}

function legacySessionResponse(
  premiereState: ReplayPremiereServiceSessionResponse["premiereState"],
): ReplayPremiereServiceSessionResponse {
  return {
    ...legacySessionResponseRaw(premiereState),
    reactionSummary: null,
    clipsEnabled: null,
    clipEligibility: null,
  };
}

function legacyReactionResponse(): ReplayPremiereServiceReactionResponse {
  return {
    ...legacyReactionResponseRaw(),
    reactionSummary: null,
    clipsEnabled: null,
    clipEligibility: null,
  };
}

function legacyHeartbeatResponse(
  premiereState: ReplayPremiereServiceHeartbeatResponse["premiereState"],
): ReplayPremiereServiceHeartbeatResponse {
  return {
    ...legacyHeartbeatResponseRaw(premiereState),
    reactionSummary: null,
    clipsEnabled: null,
    clipEligibility: null,
  };
}

function clipEligibility(
  overrides: Partial<ReplayPremiereClipEligibility> = {},
): ReplayPremiereClipEligibility {
  return {
    generationEnabled: true,
    renderableThroughTurn: 1_000,
    sourceComplete: false,
    ...overrides,
  };
}

function emptyReactionSummary(): ReplayPremiereServiceReactionSummary {
  return {
    totalReactions: 0,
    distinctParticipants: 0,
    byKind: {
      turning_point: 0,
      smart: 0,
      mistake: 0,
      betrayal: 0,
      clip_this: 0,
    },
    ownByKind: {
      turning_point: 0,
      smart: 0,
      mistake: 0,
      betrayal: 0,
      clip_this: 0,
    },
  };
}

function reactionSummaryWith(
  kind: keyof ReplayPremiereServiceReactionSummary["byKind"],
  count: number,
  distinctParticipants = count > 0 ? 1 : 0,
): ReplayPremiereServiceReactionSummary {
  const summary = emptyReactionSummary();
  summary.totalReactions = count;
  summary.distinctParticipants = distinctParticipants;
  summary.byKind[kind] = count;
  summary.ownByKind![kind] = count;
  return summary;
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

function clipStatus(
  state: "ready" | "pending" | "absent",
  bucket = 6,
): ReplayPremiereClipStatusResponse {
  return {
    schemaVersion: 1,
    premiereId: PREMIERE_ID,
    bucket,
    clipVersion: 1,
    state,
    ready:
      state === "ready"
        ? {
            clipUrl: `/premiere/${PREMIERE_ID}/clip-v1-${bucket}.mp4`,
            byteLength: 2_048,
            sha256: HASH_A,
            anchorTurn: 60,
            social: { caption: CLIP_CAPTION, firstReply: CLIP_REPLY },
          }
        : null,
  };
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
