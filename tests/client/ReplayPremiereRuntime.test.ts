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
    onBind?: () => void;
  };
  onJoin?: () => void;
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
    submitReaction: vi.fn(),
    createShare: vi.fn(),
    dispose: vi.fn(),
  };
  const onJoin = vi.fn(options.onJoin);
  const runtime = new ReplayPremiereRuntimeController({
    premiereId: PREMIERE_ID,
    onJoinReady: onJoin,
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

function archivedPointer(): ReplayPremiereManifest {
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
): ReplayPremierePreRevealManifest {
  return {
    ...playingManifest(),
    state: "checkpoint",
    serverNow,
    authoritativeElapsedMs: 10_000,
    releasedThroughSequence: 10,
    activeCheckpoint: {
      id: "cp_12345678",
      sequence: 10,
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
