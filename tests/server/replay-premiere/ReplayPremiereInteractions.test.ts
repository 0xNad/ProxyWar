import type { PremiereCanonicalAuthoritativeResult } from "../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { PremiereState } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import {
  countRepeatQualifiedPremiereParticipants,
  deriveReplayPremierePredictionOutcome,
  ReplayPremiereInteractions,
  type ReplayPremiereAnonymousWriteAdmissionRequest,
  type ReplayPremiereInteractionLimits,
  type ReplayPremiereInteractionsSnapshot,
} from "../../../src/server/replay-premiere/ReplayPremiereInteractions";

describe("ReplayPremiereInteractions", () => {
  const premiereId = "prem_abcdefghijklmnop";
  const guestA = `guest_${"a".repeat(32)}`;
  const guestB = `guest_${"b".repeat(32)}`;
  const guestC = `guest_${"c".repeat(32)}`;

  function harness(
    initialState?: ReplayPremiereInteractionsSnapshot,
    overrides?: {
      limits?: Partial<ReplayPremiereInteractionLimits>;
      admitAnonymousWrite?: (
        request: ReplayPremiereAnonymousWriteAdmissionRequest,
      ) => void;
      minHeartbeatIntervalMs?: number;
      initialNowMs?: number;
      onGetReleasedContext?: (sequence: number) => void;
      beforePersist?: (
        eventType: string,
        nextState: ReplayPremiereInteractionsSnapshot,
      ) => Promise<void>;
    },
  ) {
    let nowMs =
      overrides?.initialNowMs ?? Date.parse("2026-07-20T12:00:00.000Z");
    let releasedThroughSequence = 80;
    let premiereState: PremiereState = "playing";
    let randomValue = 1;
    let requestValue = 1;
    const persisted: Array<{
      eventType: string;
      state: ReplayPremiereInteractionsSnapshot;
    }> = [];
    const admissions: ReplayPremiereAnonymousWriteAdmissionRequest[] = [];
    const interactions = new ReplayPremiereInteractions({
      premiereId,
      checkpointDescriptors: [
        { id: "cp_first0001", sequence: 35 },
        { id: "cp_second001", sequence: 65 },
      ],
      seats: [
        {
          seatId: "seat-1",
          policyIdentity: {
            namespace: "local_manifest",
            manifestName: "alpha",
            declaredVersion: "1",
            manifestSha256: "1".repeat(64),
            contentSha256: "2".repeat(64),
          },
        },
        {
          seatId: "SEAT0001",
          policyIdentity: {
            namespace: "local_manifest",
            manifestName: "beta",
            declaredVersion: "1",
            manifestSha256: "3".repeat(64),
            contentSha256: "4".repeat(64),
          },
        },
      ],
      getPremiereState: () => premiereState,
      getReleasedContext: (sequence) => {
        overrides?.onGetReleasedContext?.(sequence);
        return sequence <= releasedThroughSequence
          ? {
              releasedThroughSequence,
              turn: sequence,
              eventContext: { headline: `released-${sequence}` },
            }
          : null;
      },
      getLiveVisibleSequence: () => releasedThroughSequence,
      persistence: {
        async persist({ eventType, nextState }) {
          await overrides?.beforePersist?.(eventType, nextState);
          persisted.push({ eventType, state: structuredClone(nextState) });
        },
      },
      signAttribution: ({ shareId }) => `signed-${shareId}`,
      canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
      now: () => new Date(nowMs),
      randomBytes: (size) => {
        const bytes = new Uint8Array(size).fill(randomValue);
        randomValue += 1;
        return bytes;
      },
      initialState,
      limits: overrides?.limits,
      minHeartbeatIntervalMs: overrides?.minHeartbeatIntervalMs,
      admitAnonymousWrite(request) {
        admissions.push(structuredClone(request));
        overrides?.admitAnonymousWrite?.(request);
      },
    });
    return {
      interactions,
      persisted,
      admissions,
      setReleased(sequence: number) {
        releasedThroughSequence = sequence;
      },
      setPremiereState(state: PremiereState) {
        premiereState = state;
      },
      advance(ms: number) {
        nowMs += ms;
      },
      nextIdempotencyKey() {
        const key = `idem_${String(requestValue).padStart(16, "0")}`;
        requestValue += 1;
        return key;
      },
      now: () => new Date(nowMs).toISOString(),
    };
  }

  async function createSession(
    h: ReturnType<typeof harness>,
    participantId: string,
  ) {
    return h.interactions.createViewerSession({
      participantId,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 35,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
  }

  function submitPrediction(
    h: ReturnType<typeof harness>,
    options: {
      participantId: string;
      sessionId: string;
      checkpointId: string;
      selectedSeatId: string;
    },
  ) {
    return h.interactions.submitPrediction({
      ...options,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"1".repeat(64)}`,
    });
  }

  function submitReaction(
    h: ReturnType<typeof harness>,
    options: {
      participantId: string;
      sessionId: string;
      sequence: number;
      kind: "smart" | "mistake" | "betrayal" | "turning_point" | "clip_this";
      policySeatId?: string | null;
    },
  ) {
    return h.interactions.submitReaction({
      ...options,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"1".repeat(64)}`,
    });
  }

  function authoritativeResult(
    winner: PremiereCanonicalAuthoritativeResult["winner"],
  ): PremiereCanonicalAuthoritativeResult {
    return {
      schemaVersion: 1,
      sourceKind: "controlled_result",
      sourceRunId: "controlled-run-1",
      sourceId: "controlled-source-1",
      gameId: "game-1",
      completedAt: "2026-07-20T11:55:00.000Z",
      turnCount: 80,
      winner,
      seats: [
        { seatId: "seat-1", displayName: "Alpha", won: false },
        { seatId: "SEAT0001", displayName: "Beta", won: false },
      ],
    };
  }

  async function closeBothCheckpoints(
    h: ReturnType<typeof harness>,
    sessionId?: string,
  ): Promise<void> {
    for (const checkpointId of ["cp_first0001", "cp_second001"]) {
      await h.interactions.openCheckpoint({
        checkpointId,
        opensAt: h.now(),
        closesAt: new Date(
          Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
        ).toISOString(),
        optionSeatIds: ["seat-1", "SEAT0001"],
      });
      if (sessionId !== undefined) {
        await submitPrediction(h, {
          participantId: guestA,
          sessionId,
          checkpointId,
          selectedSeatId: "seat-1",
        });
      }
      h.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
      await h.interactions.closeCheckpoint(checkpointId, h.now());
    }
  }

  it("enforces hidden prediction distributions, idempotency, conflicts, and late 410", async () => {
    const h = harness();
    const sessionA = await createSession(h, guestA);
    const sessionB = await createSession(h, guestB);
    await h.interactions.openCheckpoint({
      checkpointId: "cp_first0001",
      opensAt: h.now(),
      closesAt: new Date(
        Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
      ).toISOString(),
      optionSeatIds: ["seat-1", "SEAT0001"],
    });

    expect(
      h.interactions.readCheckpoint("cp_first0001", guestB).distribution,
    ).toBeNull();
    const accepted = await submitPrediction(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      checkpointId: "cp_first0001",
      selectedSeatId: "seat-1",
    });
    expect(accepted.idempotent).toBe(false);
    expect(
      h.interactions.readCheckpoint("cp_first0001", guestA).distribution,
    ).toEqual({ "seat-1": 1, SEAT0001: 0 });

    const persistedBeforeRetry = h.persisted.length;
    await expect(
      submitPrediction(h, {
        participantId: guestA,
        sessionId: sessionA.id,
        checkpointId: "cp_first0001",
        selectedSeatId: "seat-1",
      }),
    ).resolves.toMatchObject({ idempotent: true });
    expect(h.persisted).toHaveLength(persistedBeforeRetry);

    await expect(
      submitPrediction(h, {
        participantId: guestA,
        sessionId: sessionB.id,
        checkpointId: "cp_first0001",
        selectedSeatId: "seat-1",
      }),
    ).rejects.toMatchObject({ httpStatus: 404 });

    const conflict = await submitPrediction(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      checkpointId: "cp_first0001",
      selectedSeatId: "SEAT0001",
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ReplayPremiereError);
    expect((conflict as ReplayPremiereError).httpStatus).toBe(409);

    h.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
    const late = await submitPrediction(h, {
      participantId: guestB,
      sessionId: sessionB.id,
      checkpointId: "cp_first0001",
      selectedSeatId: "SEAT0001",
    }).catch((error: unknown) => error);
    expect((late as ReplayPremiereError).httpStatus).toBe(410);
    expect(
      h.interactions.readCheckpoint("cp_first0001", guestB).distribution,
    ).toEqual({ "seat-1": 1, SEAT0001: 0 });
  });

  it("serializes concurrent reaction clicks and never accepts more than five per minute", async () => {
    const h = harness();
    const session = await createSession(h, guestA);
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6].map((sequence) =>
        submitReaction(h, {
          participantId: guestA,
          sessionId: session.id,
          sequence,
          kind: "smart",
          policySeatId: "seat-1",
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(5);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect((rejected.reason as ReplayPremiereError).httpStatus).toBe(429);
    }
    expect(h.interactions.readState().reactions).toHaveLength(5);

    const beforeDuplicate = h.persisted.length;
    await expect(
      submitReaction(h, {
        participantId: guestA,
        sessionId: session.id,
        sequence: 1,
        kind: "smart",
        policySeatId: "seat-1",
      }),
    ).resolves.toMatchObject({ idempotent: true });
    expect(h.persisted).toHaveLength(beforeDuplicate);

    for (let batch = 1; batch <= 5; batch += 1) {
      h.advance(60_001);
      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          submitReaction(h, {
            participantId: guestA,
            sessionId: session.id,
            sequence: 10 + batch * 10 + index,
            kind: "mistake",
          }),
        ),
      );
    }
    expect(h.interactions.readState().reactions).toHaveLength(30);
    h.advance(60_001);
    await expect(
      submitReaction(h, {
        participantId: guestA,
        sessionId: session.id,
        sequence: 79,
        kind: "betrayal",
      }),
    ).rejects.toMatchObject({ httpStatus: 429 });
  });

  it("derives reaction context only from released sequence and rejects future markers", async () => {
    const h = harness();
    h.setReleased(10);
    const session = await h.interactions.createViewerSession({
      participantId: guestA,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 10,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    const reaction = await submitReaction(h, {
      participantId: guestA,
      sessionId: session.id,
      sequence: 10,
      kind: "turning_point",
    });
    expect(reaction.reaction.eventContext).toEqual({ headline: "released-10" });
    await expect(
      submitReaction(h, {
        participantId: guestA,
        sessionId: session.id,
        sequence: 11,
        kind: "mistake",
      }),
    ).rejects.toMatchObject({ httpStatus: 410 });
  });

  it("returns aggregate crowd reactions plus participant-only counts", async () => {
    const h = harness();
    const sessionA = await createSession(h, guestA);
    const sessionB = await createSession(h, guestB);
    await submitReaction(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      sequence: 10,
      kind: "smart",
    });
    await submitReaction(h, {
      participantId: guestB,
      sessionId: sessionB.id,
      sequence: 11,
      kind: "smart",
    });
    await submitReaction(h, {
      participantId: guestB,
      sessionId: sessionB.id,
      sequence: 12,
      kind: "mistake",
    });

    expect(h.interactions.readReactionSummary(guestA)).toEqual({
      totalReactions: 3,
      distinctParticipants: 2,
      byKind: {
        turning_point: 0,
        smart: 2,
        mistake: 1,
        betrayal: 0,
        clip_this: 0,
      },
      ownByKind: {
        turning_point: 0,
        smart: 1,
        mistake: 0,
        betrayal: 0,
        clip_this: 0,
      },
    });
    expect(h.interactions.readReactionSummary(null)).toMatchObject({
      totalReactions: 3,
      distinctParticipants: 2,
      ownByKind: null,
    });

    const recovered = harness(h.interactions.readState());
    expect(recovered.interactions.readReactionSummary(guestB)).toEqual({
      totalReactions: 3,
      distinctParticipants: 2,
      byKind: {
        turning_point: 0,
        smart: 2,
        mistake: 1,
        betrayal: 0,
        clip_this: 0,
      },
      ownByKind: {
        turning_point: 0,
        smart: 1,
        mistake: 1,
        betrayal: 0,
        clip_this: 0,
      },
    });
  });

  it("rebuilds participant-private latest reaction anchors from a validated snapshot", async () => {
    const h = harness();
    const sessionA = await createSession(h, guestA);
    const sessionB = await createSession(h, guestB);
    await submitReaction(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      sequence: 10,
      kind: "smart",
    });
    const latestA = await submitReaction(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      sequence: 12,
      kind: "clip_this",
    });
    const latestB = await submitReaction(h, {
      participantId: guestB,
      sessionId: sessionB.id,
      sequence: 11,
      kind: "mistake",
    });

    expect(h.interactions.readLatestOwnReaction(guestA)).toEqual({
      id: latestA.reaction.id,
      kind: "clip_this",
      sequence: 12,
      turn: 12,
    });
    expect(h.interactions.readLatestOwnReaction(guestB)).toEqual({
      id: latestB.reaction.id,
      kind: "mistake",
      sequence: 11,
      turn: 11,
    });
    expect(h.interactions.readLatestOwnReaction(guestC)).toBeNull();
    expect(h.interactions.readLatestOwnReaction(null)).toBeNull();
    expect(
      Object.keys(h.interactions.readReactionSummary(null)).sort(),
    ).toEqual(
      ["totalReactions", "distinctParticipants", "byKind", "ownByKind"].sort(),
    );

    const recovered = harness(h.interactions.readState());
    const recoveredA = recovered.interactions.readLatestOwnReaction(guestA);
    expect(recoveredA).toEqual({
      id: latestA.reaction.id,
      kind: "clip_this",
      sequence: 12,
      turn: 12,
    });
    expect(recovered.interactions.readLatestOwnReaction(guestB)).toEqual({
      id: latestB.reaction.id,
      kind: "mistake",
      sequence: 11,
      turn: 11,
    });
    expect(recovered.interactions.readLatestOwnReaction(guestC)).toBeNull();
    if (recoveredA !== null) recoveredA.sequence = 999;
    expect(recovered.interactions.readLatestOwnReaction(guestA)?.sequence).toBe(
      12,
    );
  });

  it("indexes released reactions once across summaries and non-reaction mutations", async () => {
    const releasedContextCalls = new Map<number, number>();
    const h = harness(undefined, {
      onGetReleasedContext(sequence) {
        releasedContextCalls.set(
          sequence,
          (releasedContextCalls.get(sequence) ?? 0) + 1,
        );
      },
    });
    const sessionA = await createSession(h, guestA);
    const sessionB = await createSession(h, guestB);
    for (const marker of [
      { participantId: guestA, sessionId: sessionA.id, sequence: 10 },
      { participantId: guestB, sessionId: sessionB.id, sequence: 11 },
      { participantId: guestB, sessionId: sessionB.id, sequence: 12 },
    ]) {
      await submitReaction(h, { ...marker, kind: "smart" });
    }
    expect(
      [10, 11, 12].map((sequence) => releasedContextCalls.get(sequence)),
    ).toEqual([1, 1, 1]);

    for (let index = 0; index < 20; index += 1) {
      h.interactions.readReactionSummary(index % 2 === 0 ? guestA : null);
    }
    h.advance(1_000);
    await h.interactions.heartbeat({
      participantId: guestA,
      sessionId: sessionA.id,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 35,
    });
    expect(
      [10, 11, 12].map((sequence) => releasedContextCalls.get(sequence)),
    ).toEqual([1, 1, 1]);

    await submitReaction(h, {
      participantId: guestA,
      sessionId: sessionA.id,
      sequence: 13,
      kind: "betrayal",
    });
    expect(releasedContextCalls.get(13)).toBe(1);
    const appended = h.interactions.readReactionSummary(guestA);
    expect(appended).toMatchObject({
      totalReactions: 4,
      distinctParticipants: 2,
      byKind: { smart: 3, betrayal: 1 },
      ownByKind: { smart: 1, betrayal: 1 },
    });
    appended.byKind.smart = 999;
    if (appended.ownByKind !== null) appended.ownByKind.smart = 999;
    expect(h.interactions.readReactionSummary(guestA)).toMatchObject({
      byKind: { smart: 3 },
      ownByKind: { smart: 1 },
    });
    expect(
      [10, 11, 12, 13].map((sequence) => releasedContextCalls.get(sequence)),
    ).toEqual([1, 1, 1, 1]);
  });

  it("qualifies visible or interacting sessions once per participant and preserves last non-direct attribution", async () => {
    const h = harness();
    const sourceSession = await h.interactions.createViewerSession({
      participantId: guestB,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"2".repeat(32)}`,
      visible: true,
      observedSequence: 10,
      excludedAsOperator: true,
      excludedAsBot: false,
    });
    const sourceShare = await h.interactions.createShare({
      participantId: guestB,
      sessionId: sourceSession.id,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"2".repeat(32)}`,
      sequence: 10,
    });
    const attribution = {
      attributionId: guestB,
      shareId: sourceShare.share.id,
      premiereId,
      issuedAt: h.now(),
      expiresAt: new Date(
        Date.parse(h.now()) + 7 * 24 * 60 * 60 * 1_000,
      ).toISOString(),
    };
    const session = await h.interactions.createViewerSession({
      participantId: guestA,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 10,
      excludedAsOperator: false,
      excludedAsBot: false,
      incomingAttribution: attribution,
    });
    for (let index = 0; index < 5; index += 1) {
      h.advance(60_000);
      await h.interactions.heartbeat({
        participantId: guestA,
        sessionId: session.id,
        idempotencyKey: h.nextIdempotencyKey(),
        requesterBucketId: `ip_${"1".repeat(32)}`,
        visible: true,
        observedSequence: 10 + index,
      });
    }
    expect(h.interactions.readMetrics()).toMatchObject({
      qualifiedParticipants: 1,
      attributedQualifiedParticipants: 1,
    });

    const second = await createSession(h, guestA);
    const share = await h.interactions.createShare({
      participantId: guestA,
      sessionId: second.id,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"1".repeat(32)}`,
      sequence: 12,
    });
    expect(share.url).toContain("moment=share_");
    expect(share.url).toContain("attribution=signed-share_");
    expect(h.interactions.readMetrics().qualifiedParticipants).toBe(1);
  });

  it("rejects client-claimed future observed sequences", async () => {
    const h = harness();
    await expect(
      h.interactions.createViewerSession({
        participantId: guestA,
        idempotencyKey: h.nextIdempotencyKey(),
        requesterBucketId: `ip_${"1".repeat(32)}`,
        visible: true,
        observedSequence: 81,
        excludedAsOperator: false,
        excludedAsBot: false,
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });

    const session = await createSession(h, guestA);
    await expect(
      h.interactions.heartbeat({
        participantId: guestA,
        sessionId: session.id,
        idempotencyKey: h.nextIdempotencyKey(),
        requesterBucketId: `ip_${"1".repeat(32)}`,
        visible: true,
        observedSequence: 81,
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("caps cumulative checkpoint outage shifts at sixty seconds and remains restartable", async () => {
    const h = harness();
    await h.interactions.openCheckpoint({
      checkpointId: "cp_first0001",
      opensAt: h.now(),
      closesAt: new Date(
        Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
      ).toISOString(),
      optionSeatIds: ["seat-1", "SEAT0001"],
    });
    await h.interactions.shiftOpenCheckpointForOutage({
      checkpointId: "cp_first0001",
      outageMs: 40_000,
      occurredAt: h.now(),
    });
    const shifted = await h.interactions.shiftOpenCheckpointForOutage({
      checkpointId: "cp_first0001",
      outageMs: 20_000,
      occurredAt: h.now(),
    });
    expect(shifted.outageShiftMs).toBe(60_000);
    expect(
      Date.parse(shifted.closesAt ?? "") - Date.parse(shifted.opensAt ?? ""),
    ).toBe(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 60_000);
    await expect(
      h.interactions.shiftOpenCheckpointForOutage({
        checkpointId: "cp_first0001",
        outageMs: 1,
        occurredAt: h.now(),
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(() => harness(h.interactions.readState())).not.toThrow();
  });

  it("prepares checkpoint transitions without visibility and commits only after caller durability", async () => {
    const h = harness();
    const preparedOpen = h.interactions.prepareOpenCheckpoint({
      checkpointId: "cp_first0001",
      opensAt: h.now(),
      closesAt: new Date(
        Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
      ).toISOString(),
      optionSeatIds: ["seat-1", "SEAT0001"],
    });
    expect(h.interactions.readCheckpoint("cp_first0001", null).state).toBe(
      "upcoming",
    );
    expect(preparedOpen.nextState.checkpoints[0].state).toBe("open");
    await expect(createSession(h, guestA)).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(h.persisted).toHaveLength(0);
    preparedOpen.commit();
    expect(h.interactions.readCheckpoint("cp_first0001", null).state).toBe(
      "open",
    );
    expect(() => preparedOpen.commit()).toThrow(/stale_interaction_transition/);

    const preparedShift = h.interactions.prepareShiftOpenCheckpointForOutage({
      checkpointId: "cp_first0001",
      outageMs: 5_000,
      occurredAt: h.now(),
    });
    expect(preparedShift.nextState.checkpoints[0].outageShiftMs).toBe(5_000);
    expect(
      h.interactions.readCheckpoint("cp_first0001", null).outageShiftMs,
    ).toBe(0);
    preparedShift.abort();
    expect(
      h.interactions.readCheckpoint("cp_first0001", null).outageShiftMs,
    ).toBe(0);

    const committedShift = h.interactions.prepareShiftOpenCheckpointForOutage({
      checkpointId: "cp_first0001",
      outageMs: 5_000,
      occurredAt: h.now(),
    });
    committedShift.commit();
    const closesAt = committedShift.result.closesAt;
    expect(closesAt).not.toBeNull();
    const preparedClose = h.interactions.prepareCloseCheckpoint(
      "cp_first0001",
      closesAt!,
    );
    expect(h.interactions.readCheckpoint("cp_first0001", null).state).toBe(
      "open",
    );
    preparedClose.commit();
    expect(h.interactions.readCheckpoint("cp_first0001", null).state).toBe(
      "closed",
    );
    expect(() =>
      h.interactions.restoreState(h.interactions.readState()),
    ).not.toThrow();
  });

  it("fences later writes while draining and retaining already queued state", async () => {
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    let notifyPersistenceEntered!: () => void;
    const persistenceEntered = new Promise<void>((resolve) => {
      notifyPersistenceEntered = resolve;
    });
    const h = harness(undefined, {
      async beforePersist(eventType) {
        if (eventType !== "viewer_session_started") return;
        notifyPersistenceEntered();
        await persistenceGate;
      },
    });

    const admittedBeforeFence = createSession(h, guestA);
    await persistenceEntered;
    const drain = h.interactions.fenceWritesAndDrain();
    expect(h.interactions.fenceWritesAndDrain()).toBe(drain);
    await expect(createSession(h, guestB)).rejects.toMatchObject({
      httpStatus: 410,
      operatorCode: "interaction_writes_fenced",
    });
    expect(h.admissions).toHaveLength(1);

    releasePersistence();
    const admittedSession = await admittedBeforeFence;
    await expect(drain).resolves.toBeUndefined();
    expect(h.interactions.readState().sessions).toEqual([
      expect.objectContaining({ id: admittedSession.id }),
    ]);
    expect(h.persisted).toHaveLength(1);
    await expect(createSession(h, guestC)).rejects.toMatchObject({
      httpStatus: 410,
      operatorCode: "interaction_writes_fenced",
    });
  });

  it("fails a write drain closed while a prepared transition is active", async () => {
    const h = harness();
    const prepared = h.interactions.prepareOpenCheckpoint({
      checkpointId: "cp_first0001",
      opensAt: h.now(),
      closesAt: new Date(
        Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
      ).toISOString(),
      optionSeatIds: ["seat-1", "SEAT0001"],
    });
    await expect(h.interactions.fenceWritesAndDrain()).rejects.toMatchObject({
      httpStatus: 409,
      operatorCode: "interaction_prepared_transition_during_write_drain",
    });
    prepared.abort();
    expect(() =>
      h.interactions.prepareOpenCheckpoint({
        checkpointId: "cp_first0001",
        opensAt: h.now(),
        closesAt: new Date(
          Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
        ).toISOString(),
        optionSeatIds: ["seat-1", "SEAT0001"],
      }),
    ).toThrow(/interaction_writes_fenced/);
  });

  it("fails closed on malformed restart projections instead of trusting typed input", async () => {
    const h = harness();
    const session = await createSession(h, guestA);
    await h.interactions.openCheckpoint({
      checkpointId: "cp_first0001",
      opensAt: h.now(),
      closesAt: new Date(
        Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
      ).toISOString(),
      optionSeatIds: ["seat-1", "SEAT0001"],
    });
    await submitPrediction(h, {
      participantId: guestA,
      sessionId: session.id,
      checkpointId: "cp_first0001",
      selectedSeatId: "seat-1",
    });
    await submitReaction(h, {
      participantId: guestA,
      sessionId: session.id,
      sequence: 20,
      kind: "smart",
      policySeatId: "SEAT0001",
    });
    await h.interactions.createShare({
      participantId: guestA,
      sessionId: session.id,
      idempotencyKey: h.nextIdempotencyKey(),
      requesterBucketId: `ip_${"1".repeat(32)}`,
      sequence: 20,
    });
    const valid = h.interactions.readState();
    expect(() => harness(valid)).not.toThrow();

    const futureObservation = structuredClone(valid);
    futureObservation.sessions[0].lastReleasedSequenceObserved = 81;
    expect(() => harness(futureObservation)).toThrow(ReplayPremiereError);

    const counterMismatch = structuredClone(valid);
    counterMismatch.sessions[0].reactionCount = 0;
    expect(() => harness(counterMismatch)).toThrow(ReplayPremiereError);

    const unknownSeat = structuredClone(valid);
    unknownSeat.checkpoints[0].optionSeatIds[0] = "seat-unknown";
    expect(() => harness(unknownSeat)).toThrow(ReplayPremiereError);

    const duplicateVote = structuredClone(valid);
    duplicateVote.predictions.push(structuredClone(valid.predictions[0]));
    expect(() => harness(duplicateVote)).toThrow(ReplayPremiereError);

    const extraField = structuredClone(
      valid,
    ) as ReplayPremiereInteractionsSnapshot & {
      privatePath?: string;
    };
    extraField.privatePath = "/private/result";
    expect(() => harness(extraField)).toThrow(ReplayPremiereError);
  });

  it("converges every tab/reload for one participant onto their single live session, and still enforces distinct-session, premiere, and service admission ceilings", async () => {
    const h = harness(undefined, {
      limits: {
        maxSessionsPerParticipant: 2,
        maxSessionCreatesPerParticipantPerMinute: 2,
      },
    });
    const idempotencyKey = h.nextIdempotencyKey();
    const request = {
      participantId: guestA,
      idempotencyKey,
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 10,
      excludedAsOperator: false,
      excludedAsBot: false,
    };
    const [first, retry] = await Promise.all([
      h.interactions.createViewerSession(request),
      h.interactions.createViewerSession(request),
    ]);
    expect(retry.id).toBe(first.id);
    expect(h.persisted).toHaveLength(1);
    expect(h.admissions).toHaveLength(2);
    await expect(
      h.interactions.createViewerSession({ ...request, visible: false }),
    ).rejects.toMatchObject({ httpStatus: 409 });

    // A brand-new tab (or a cold reload with no persisted pointer) has no
    // way to know the idempotencyKey a prior tab used, so it always sends
    // a fresh one — this is the exact case the exact-key check above can
    // never catch. Any number of such "new tab" calls must converge onto
    // the participant's one live session: same session id back every
    // time, and the session record count for this participant never
    // grows past 1, no matter how many tabs are opened.
    for (let tab = 0; tab < 8; tab += 1) {
      const opened = await h.interactions.createViewerSession({
        ...request,
        idempotencyKey: h.nextIdempotencyKey(),
      });
      expect(opened.id).toBe(first.id);
    }
    expect(
      h.interactions
        .readState()
        .sessions.filter((session) => session.participantId === guestA),
    ).toHaveLength(1);
    expect(h.persisted).toHaveLength(1);

    // The per-participant record ceiling still protects a genuinely
    // distinct-session scenario: once a session has actually ended (the
    // only way a participant can legitimately accumulate more than one
    // record), a subsequent create is a real creation again, and the
    // ceiling — and the per-minute creation-rate limit — still apply
    // exactly as before. Fabricates two already-ended session records
    // directly (there is no live "end session" API to drive this through
    // yet) so the cap-exhaustion path itself is exercised, not skipped.
    const endedTemplate = h.interactions.readState().sessions[0];
    const seeded = harness(
      {
        ...h.interactions.readState(),
        sessions: [
          {
            ...endedTemplate,
            id: `sess_${"e".repeat(32)}`,
            idempotencyKey: "idem_seed00000000000001",
            endedAt: h.now(),
          },
          {
            ...endedTemplate,
            id: `sess_${"f".repeat(32)}`,
            idempotencyKey: "idem_seed00000000000002",
            endedAt: h.now(),
          },
        ],
      },
      {
        limits: {
          maxSessionsPerParticipant: 2,
          maxSessionCreatesPerParticipantPerMinute: 2,
        },
      },
    );
    await expect(
      seeded.interactions.createViewerSession({
        ...request,
        idempotencyKey: seeded.nextIdempotencyKey(),
      }),
    ).rejects.toMatchObject({ httpStatus: 429 });

    const premiereBounded = harness(undefined, {
      limits: {
        maxSessionsPerPremiere: 2,
        maxSessionsPerParticipant: 2,
        maxSessionCreatesPerParticipantPerMinute: 2,
      },
    });
    for (const participantId of [guestA, guestB]) {
      await premiereBounded.interactions.createViewerSession({
        ...request,
        participantId,
        idempotencyKey: premiereBounded.nextIdempotencyKey(),
      });
    }
    await expect(
      premiereBounded.interactions.createViewerSession({
        ...request,
        participantId: guestC,
        idempotencyKey: premiereBounded.nextIdempotencyKey(),
      }),
    ).rejects.toMatchObject({ httpStatus: 429 });

    let serviceWrites = 0;
    const serviceBounded = harness(undefined, {
      admitAnonymousWrite() {
        if (serviceWrites >= 1) {
          throw new ReplayPremiereError(
            "service_write_limit",
            "PREMIERE_CAPACITY_EXCEEDED",
            429,
            "service write limit",
          );
        }
        serviceWrites += 1;
      },
    });
    await createSession(serviceBounded, guestA);
    await expect(createSession(serviceBounded, guestB)).rejects.toMatchObject({
      httpStatus: 429,
    });
    expect(serviceBounded.persisted).toHaveLength(1);
  });

  it("deduplicates share writes and fails closed at share and total record capacity", async () => {
    const h = harness(undefined, {
      limits: {
        maxSharesPerParticipant: 2,
        maxSharesPerSession: 2,
        maxShareCreatesPerParticipantPerMinute: 2,
      },
    });
    const session = await createSession(h, guestA);
    const idempotencyKey = h.nextIdempotencyKey();
    const request = {
      participantId: guestA,
      sessionId: session.id,
      idempotencyKey,
      requesterBucketId: `ip_${"1".repeat(32)}`,
      sequence: 20,
    };
    const persistedBefore = h.persisted.length;
    const [first, retry] = await Promise.all([
      h.interactions.createShare(request),
      h.interactions.createShare(request),
    ]);
    expect(first.idempotent).toBe(false);
    expect(retry).toMatchObject({
      idempotent: true,
      share: { id: first.share.id },
    });
    expect(h.persisted).toHaveLength(persistedBefore + 1);
    expect(
      h.admissions.filter((entry) => entry.route === "share"),
    ).toHaveLength(2);
    await expect(
      h.interactions.createShare({ ...request, sequence: 21 }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    await h.interactions.createShare({
      ...request,
      idempotencyKey: h.nextIdempotencyKey(),
      sequence: 21,
    });
    await expect(
      h.interactions.createShare({
        ...request,
        idempotencyKey: h.nextIdempotencyKey(),
        sequence: 22,
      }),
    ).rejects.toMatchObject({ httpStatus: 429 });

    const totalBounded = harness(undefined, {
      limits: {
        maxTotalRecords: 4,
        maxSessionsPerPremiere: 1,
        maxSessionsPerParticipant: 1,
        maxSessionCreatesPerParticipantPerMinute: 1,
        maxSharesPerPremiere: 1,
        maxSharesPerParticipant: 1,
        maxSharesPerSession: 1,
        maxShareCreatesPerParticipantPerMinute: 1,
      },
    });
    const boundedSession = await createSession(totalBounded, guestA);
    await totalBounded.interactions.createShare({
      participantId: guestA,
      sessionId: boundedSession.id,
      idempotencyKey: totalBounded.nextIdempotencyKey(),
      requesterBucketId: `ip_${"1".repeat(32)}`,
      sequence: 20,
    });
    await expect(
      submitReaction(totalBounded, {
        participantId: guestA,
        sessionId: boundedSession.id,
        sequence: 21,
        kind: "smart",
      }),
    ).rejects.toMatchObject({ httpStatus: 429 });
  });

  it("suppresses heartbeat hammers, deduplicates accepted writes across restart, and rate limits persistence", async () => {
    const limits = { maxHeartbeatWritesPerSessionPerMinute: 2 };
    const h = harness(undefined, {
      limits,
      minHeartbeatIntervalMs: 1_000,
    });
    const session = await createSession(h, guestA);
    const persistedAfterSession = h.persisted.length;
    const hammered = await Promise.all(
      Array.from({ length: 20 }, () =>
        h.interactions.heartbeat({
          participantId: guestA,
          sessionId: session.id,
          idempotencyKey: h.nextIdempotencyKey(),
          requesterBucketId: `ip_${"1".repeat(32)}`,
          visible: true,
          observedSequence: 35,
        }),
      ),
    );
    expect(hammered.every((result) => !result.persisted)).toBe(true);
    expect(h.persisted).toHaveLength(persistedAfterSession);
    expect(
      h.admissions.filter((entry) => entry.route === "heartbeat"),
    ).toHaveLength(20);

    h.advance(1_000);
    const acceptedKey = h.nextIdempotencyKey();
    const acceptedRequest = {
      participantId: guestA,
      sessionId: session.id,
      idempotencyKey: acceptedKey,
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 36,
    };
    const accepted = await Promise.all([
      h.interactions.heartbeat(acceptedRequest),
      h.interactions.heartbeat(acceptedRequest),
    ]);
    expect(accepted.filter((result) => result.persisted)).toHaveLength(1);
    expect(accepted.filter((result) => result.idempotent)).toHaveLength(1);
    expect(h.persisted).toHaveLength(persistedAfterSession + 1);
    expect(
      h.admissions.filter((entry) => entry.route === "heartbeat"),
    ).toHaveLength(22);
    await expect(
      h.interactions.heartbeat({ ...acceptedRequest, visible: false }),
    ).rejects.toMatchObject({ httpStatus: 409 });

    const restored = harness(h.interactions.readState(), {
      limits,
      minHeartbeatIntervalMs: 1_000,
      initialNowMs: Date.parse(h.now()),
    });
    await expect(
      restored.interactions.heartbeat(acceptedRequest),
    ).resolves.toMatchObject({ idempotent: true, persisted: false });
    expect(restored.persisted).toHaveLength(0);
    expect(restored.admissions).toHaveLength(1);

    restored.advance(1_000);
    await expect(
      restored.interactions.heartbeat({
        ...acceptedRequest,
        idempotencyKey: restored.nextIdempotencyKey(),
        observedSequence: 37,
      }),
    ).resolves.toMatchObject({ persisted: true });
    restored.advance(1_000);
    await expect(
      restored.interactions.heartbeat({
        ...acceptedRequest,
        idempotencyKey: restored.nextIdempotencyKey(),
        observedSequence: 38,
      }),
    ).rejects.toMatchObject({ httpStatus: 429 });
    expect(restored.persisted).toHaveLength(1);

    let admittedFloodAttempts = 0;
    const floodBounded = harness(undefined, {
      minHeartbeatIntervalMs: 1_000,
      admitAnonymousWrite(request) {
        if (request.route !== "heartbeat") return;
        if (admittedFloodAttempts >= 5) {
          throw new ReplayPremiereError(
            "heartbeat_attempt_limit",
            "PREMIERE_CAPACITY_EXCEEDED",
            429,
            "heartbeat attempt limit",
          );
        }
        admittedFloodAttempts += 1;
      },
    });
    const floodSession = await createSession(floodBounded, guestA);
    const flood = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        floodBounded.interactions.heartbeat({
          participantId: guestA,
          sessionId: floodSession.id,
          idempotencyKey: floodBounded.nextIdempotencyKey(),
          requesterBucketId: `ip_${"1".repeat(32)}`,
          visible: true,
          observedSequence: 35,
        }),
      ),
    );
    expect(
      flood.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(5);
    expect(flood.filter((result) => result.status === "rejected")).toHaveLength(
      15,
    );
    expect(floodBounded.persisted).toHaveLength(1);
  });

  it("admits prediction and reaction floods before cloning large interaction state", async () => {
    let rejectInteractiveFlood = false;
    const h = harness(undefined, {
      limits: {
        maxSessionsPerPremiere: 256,
        maxSessionsPerParticipant: 2,
        maxSessionCreatesPerParticipantPerMinute: 2,
      },
      admitAnonymousWrite(request) {
        if (
          rejectInteractiveFlood &&
          (request.route === "prediction" || request.route === "reaction")
        ) {
          throw new ReplayPremiereError(
            "interactive_attempt_limit",
            "PREMIERE_CAPACITY_EXCEEDED",
            429,
            "interactive attempt limit",
          );
        }
      },
    });
    const owner = await createSession(h, guestA);
    for (let index = 1; index <= 199; index += 1) {
      await createSession(h, `guest_${index.toString(16).padStart(32, "0")}`);
    }
    await h.interactions.openCheckpoint({
      checkpointId: "cp_first0001",
      opensAt: h.now(),
      closesAt: new Date(
        Date.parse(h.now()) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
      ).toISOString(),
      optionSeatIds: ["seat-1", "SEAT0001"],
    });
    const persistedBeforeFlood = h.persisted.length;
    const admissionsBeforeFlood = h.admissions.length;
    rejectInteractiveFlood = true;
    const flood = await Promise.allSettled(
      Array.from({ length: 200 }, (_, index) =>
        index % 2 === 0
          ? h.interactions.submitPrediction({
              participantId: guestA,
              sessionId: owner.id,
              checkpointId: "cp_first0001",
              selectedSeatId: "seat-1",
              idempotencyKey: `prediction_flood_${index.toString().padStart(16, "0")}`,
              requesterBucketId: `ip_${"1".repeat(64)}`,
            })
          : h.interactions.submitReaction({
              participantId: guestA,
              sessionId: owner.id,
              sequence: 20,
              kind: "smart",
              idempotencyKey: `reaction_flood_${index.toString().padStart(16, "0")}`,
              requesterBucketId: `ip_${"1".repeat(64)}`,
            }),
      ),
    );
    expect(flood.every((result) => result.status === "rejected")).toBe(true);
    expect(h.admissions).toHaveLength(admissionsBeforeFlood + 200);
    expect(h.persisted).toHaveLength(persistedBeforeFlood);
    expect(h.interactions.readState().sessions).toHaveLength(200);
    expect(h.interactions.readState().predictions).toHaveLength(0);
    expect(h.interactions.readState().reactions).toHaveLength(0);
  });

  it("derives checkpoint outcomes only from the authoritative winner tuple", () => {
    const eligible = new Set(["seat-1", "SEAT0001"]);
    expect(
      deriveReplayPremierePredictionOutcome(
        authoritativeResult(["player", "seat-1"]),
        eligible,
      ),
    ).toEqual({ kind: "winner", winnerSeatId: "seat-1" });
    expect(
      deriveReplayPremierePredictionOutcome(
        authoritativeResult(null),
        eligible,
      ),
    ).toEqual({ kind: "void", reason: "no_winner" });
    expect(
      deriveReplayPremierePredictionOutcome(
        authoritativeResult(["team", "alliance-a", "seat-1", "SEAT0001"]),
        eligible,
      ),
    ).toEqual({ kind: "void", reason: "ambiguous_winner" });
    expect(
      deriveReplayPremierePredictionOutcome(
        authoritativeResult(["player", "seat-unknown"]),
        eligible,
      ),
    ).toEqual({ kind: "void", reason: "invalid_result" });

    const tieAdjacentNoise = {
      ...authoritativeResult(["player", "seat-1"]),
      score: { "seat-1": 5, SEAT0001: 5 },
      seats: [
        { seatId: "seat-1", displayName: "Alpha", won: false },
        { seatId: "SEAT0001", displayName: "Beta", won: true },
      ],
    } as PremiereCanonicalAuthoritativeResult;
    expect(
      deriveReplayPremierePredictionOutcome(tieAdjacentNoise, eligible),
    ).toEqual({ kind: "winner", winnerSeatId: "seat-1" });
  });

  it("atomically persists both post-reveal resolutions and exposes crowd accuracy", async () => {
    const h = harness();
    const session = await createSession(h, guestA);
    await closeBothCheckpoints(h, session.id);
    await expect(
      h.interactions.resolvePredictionsFromAuthoritativeResult({
        result: authoritativeResult(["player", "seat-1"]),
        resolvedAt: h.now(),
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });

    h.setPremiereState("revealed");
    const persistedBefore = h.persisted.length;
    await expect(
      h.interactions.resolvePredictionsFromAuthoritativeResult({
        result: authoritativeResult(["player", "seat-1"]),
        resolvedAt: h.now(),
      }),
    ).resolves.toMatchObject({ idempotent: false });
    expect(h.persisted).toHaveLength(persistedBefore + 1);
    expect(
      h.interactions.readState().checkpoints.map((entry) => entry.resolution),
    ).toEqual([
      { kind: "winner", winnerSeatId: "seat-1", resolvedAt: h.now() },
      { kind: "winner", winnerSeatId: "seat-1", resolvedAt: h.now() },
    ]);
    expect(h.interactions.readCheckpoint("cp_first0001", guestA)).toMatchObject(
      {
        resolution: { kind: "winner", winnerSeatId: "seat-1" },
        crowdAccuracy: { correctPredictions: 1, totalPredictions: 1 },
      },
    );

    const beforeRetry = h.persisted.length;
    await expect(
      h.interactions.resolvePredictionsFromAuthoritativeResult({
        result: authoritativeResult(["player", "seat-1"]),
        resolvedAt: h.now(),
      }),
    ).resolves.toMatchObject({ idempotent: true });
    expect(h.persisted).toHaveLength(beforeRetry);
    await expect(
      h.interactions.resolvePredictionsFromAuthoritativeResult({
        result: authoritativeResult(null),
        resolvedAt: h.now(),
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("persists null and multi-winner authoritative outcomes as explicit voids", async () => {
    const noWinner = harness();
    await closeBothCheckpoints(noWinner);
    noWinner.setPremiereState("revealed");
    await noWinner.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult(null),
      resolvedAt: noWinner.now(),
    });
    expect(
      noWinner.interactions.readCheckpoint("cp_first0001", null),
    ).toMatchObject({
      resolution: { kind: "void", reason: "no_winner" },
      crowdAccuracy: null,
    });

    const ambiguous = harness();
    await closeBothCheckpoints(ambiguous);
    ambiguous.setPremiereState("revealed");
    await ambiguous.interactions.resolvePredictionsFromAuthoritativeResult({
      result: authoritativeResult(["team", "alliance-a", "seat-1", "SEAT0001"]),
      resolvedAt: ambiguous.now(),
    });
    expect(
      ambiguous.interactions.readCheckpoint("cp_second001", null),
    ).toMatchObject({
      resolution: { kind: "void", reason: "ambiguous_winner" },
      crowdAccuracy: null,
    });
  });

  it("counts repeat qualified guests across distinct premieres in a rolling 30-day window", async () => {
    const h = harness();
    const session = await createSession(h, guestA);
    await submitReaction(h, {
      participantId: guestA,
      sessionId: session.id,
      sequence: 35,
      kind: "smart",
    });
    const first = h.interactions.readState();
    const second = structuredClone(first);
    second.premiereId = "prem_secondpremiere01";
    for (const restoredSession of second.sessions) {
      restoredSession.premiereId = second.premiereId;
    }
    for (const reaction of second.reactions) {
      reaction.premiereId = second.premiereId;
    }

    expect(
      countRepeatQualifiedPremiereParticipants(
        [first, structuredClone(first), second],
        "2026-08-19T12:00:00.000Z",
      ),
    ).toBe(1);
    expect(
      countRepeatQualifiedPremiereParticipants(
        [first, second],
        "2026-08-19T12:00:00.001Z",
      ),
    ).toBe(0);
  });
});
