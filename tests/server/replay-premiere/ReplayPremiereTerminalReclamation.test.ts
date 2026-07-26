import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayPremiereArchiveStore } from "../../../src/server/replay-premiere/ReplayPremiereArchiveIndex";
import { encodePremiereAuthoritativeResult } from "../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { ReplayPremiereHttpTarget } from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { replayPremiereInteractionAggregateId } from "../../../src/server/replay-premiere/ReplayPremiereInteractionRecovery";
import {
  ReplayPremiereInteractions,
  type ReplayPremiereInteractionsSnapshot,
} from "../../../src/server/replay-premiere/ReplayPremiereInteractions";
import { reclaimUnreferencedPremiereSources } from "../../../src/server/replay-premiere/ReplayPremiereJournalCompaction";
import {
  loadReplayPremiereReclamationExclusions,
  ReplayPremiereTerminalReclaimer,
} from "../../../src/server/replay-premiere/ReplayPremiereTerminalReclamation";
import {
  authoritativeResultBytes,
  eligibilityFixture,
  seatFixtures,
} from "./ReplayPremiereFixtures";

const PREMIERE_ID = "prem_reclaimtarget001";
const SOURCE_SHA = sha256Hex("source-bundle");
const COMMITMENT = sha256Hex("commitment");
const REVEALED_AT = "2026-07-20T18:00:00.000Z";
const GRACE_MS = 30 * 60 * 1000;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-reclaim-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function emptyInteractionSnapshot(
  premiereId: string,
): ReplayPremiereInteractionsSnapshot {
  const checkpoint = (id: string, sequence: number) => ({
    id,
    sequence,
    opensAt: "2026-07-20T17:58:00.000Z",
    closesAt: "2026-07-20T17:59:00.000Z",
    outageShiftMs: 0,
    optionSeatIds: ["SEAT0001", "SEAT0002"],
    state: "closed" as const,
    resolution: {
      kind: "winner" as const,
      winnerSeatId: "SEAT0001",
      resolvedAt: REVEALED_AT,
    },
  });
  return {
    schemaVersion: 1,
    premiereId,
    checkpoints: [checkpoint("cp_00000001", 2), checkpoint("cp_00000002", 4)],
    predictions: [],
    market: null,
    trades: [],
    reactions: [],
    shares: [],
    sessions: [],
    lastNonDirectAttributionByParticipant: [],
  };
}

function target(premiereId = PREMIERE_ID): ReplayPremiereHttpTarget {
  return {
    runtime: {
      premiereId,
      readLifecycleState: () => "revealed",
      readBootstrap: () => ({
        premiereId,
        publicationCommitmentHash: COMMITMENT,
        provenance: {
          sourceKind: "controlled_exhibition",
          sourceRunId: "controlled-run-001",
          sourceReplaySha256: SOURCE_SHA,
          seats: seatFixtures(),
        },
      }),
      readReveal: () => ({
        premiereId,
        revealedAt: REVEALED_AT,
        eligibilityRecord: eligibilityFixture(),
        authoritativeResult: encodePremiereAuthoritativeResult(
          authoritativeResultBytes(),
        ),
      }),
    },
    interactions: {
      readCheckpoints: () => [],
      readState: () => emptyInteractionSnapshot(premiereId),
      hasCompletePredictionResolution: () => true,
      fenceWritesAndDrain: async () => undefined,
    },
  } as unknown as ReplayPremiereHttpTarget;
}

function unresolvedPredictionTarget(
  options: {
    interactionFence?: () => Promise<void>;
  } = {},
): ReplayPremiereHttpTarget {
  const base = target();
  const snapshot = emptyInteractionSnapshot(PREMIERE_ID);
  for (const checkpoint of snapshot.checkpoints) checkpoint.resolution = null;
  snapshot.predictions.push({
    premiereId: PREMIERE_ID,
    checkpointId: snapshot.checkpoints[0].id,
    participantId: `guest_${"f".repeat(32)}`,
    selectedSeatId: "SEAT0001",
    submittedAt: "2026-07-20T17:58:30.000Z",
    lockedAt: "2026-07-20T17:59:00.000Z",
  });
  return {
    ...base,
    interactions: {
      ...base.interactions,
      readState: () => structuredClone(snapshot),
      hasCompletePredictionResolution: () => false,
      fenceWritesAndDrain: options.interactionFence ?? (async () => undefined),
    },
  } as unknown as ReplayPremiereHttpTarget;
}

function terminalInteractions(
  beforePersist?: (eventType: string) => Promise<void>,
): ReplayPremiereInteractions {
  let randomByte = 1;
  return new ReplayPremiereInteractions({
    premiereId: PREMIERE_ID,
    checkpointDescriptors: [
      { id: "cp_00000001", sequence: 2 },
      { id: "cp_00000002", sequence: 4 },
    ],
    seats: seatFixtures().map(({ seatId, policyIdentity }) => ({
      seatId,
      policyIdentity,
    })),
    getPremiereState: () => "revealed",
    getReleasedContext: (sequence) =>
      sequence <= 6
        ? {
            releasedThroughSequence: 6,
            turn: sequence,
            eventContext: { headline: `released-${sequence}` },
          }
        : null,
    persistence: {
      async persist({ eventType }) {
        await beforePersist?.(eventType);
      },
    },
    signAttribution: ({ shareId }) => `signed-${shareId}`,
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${PREMIERE_ID}`,
    now: () => new Date("2026-07-20T18:44:00.000Z"),
    randomBytes: (size) => {
      const bytes = new Uint8Array(size).fill(randomByte);
      randomByte += 1;
      return bytes;
    },
    admitAnonymousWrite: () => undefined,
    initialState: emptyInteractionSnapshot(PREMIERE_ID),
  });
}

const admissionPath = (premiereId: string): string =>
  path.join(root, "catalog-v1", "entries", `${premiereId}.admission.json`);
const sourcePath = (): string =>
  path.join(
    root,
    "sources",
    "sha256",
    SOURCE_SHA.slice(0, 2),
    `${SOURCE_SHA}.replay`,
  );
const runtimeSnapshotPath = (premiereId: string): string =>
  path.join(root, "event-store-v1", "snapshots", `${premiereId}.snapshot.json`);
const interactionSnapshotPath = (premiereId: string): string =>
  path.join(
    root,
    "event-store-v1",
    "snapshots",
    `${replayPremiereInteractionAggregateId(premiereId)}.snapshot.json`,
  );

async function writeBulk(premiereId = PREMIERE_ID): Promise<void> {
  await fs.mkdir(path.dirname(admissionPath(premiereId)), { recursive: true });
  await fs.writeFile(
    admissionPath(premiereId),
    JSON.stringify({
      premiereId,
      stagedSource: { sourceReplaySha256: SOURCE_SHA },
    }),
  );
  await fs.mkdir(path.dirname(sourcePath()), { recursive: true });
  await fs.writeFile(sourcePath(), "private replay bytes");
  await fs.mkdir(path.dirname(runtimeSnapshotPath(premiereId)), {
    recursive: true,
  });
  await fs.writeFile(runtimeSnapshotPath(premiereId), "{}");
  await fs.writeFile(interactionSnapshotPath(premiereId), "{}");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function reclaimerWith(
  nowIso: string,
  options: {
    fenceClipWritesAndDrain?: (premiereId: string) => Promise<void>;
  } = {},
): Promise<{
  reclaimer: ReplayPremiereTerminalReclaimer;
  store: ReplayPremiereArchiveStore;
}> {
  const store = await ReplayPremiereArchiveStore.open({
    privateStateRoot: root,
  });
  return {
    store,
    reclaimer: new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store,
      graceMs: GRACE_MS,
      now: () => new Date(nowIso),
      fenceClipWritesAndDrain: options.fenceClipWritesAndDrain,
    }),
  };
}

describe("ReplayPremiereTerminalReclaimer", () => {
  it("waits out the grace window before touching anything", async () => {
    await writeBulk();
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:10:00.000Z", // 10 minutes after reveal < 30 min grace
    );
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(false);
    expect(result.reason).toBe("within_grace");
    expect(store.lookup(PREMIERE_ID)).toBeNull();
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);
    expect(await exists(sourcePath())).toBe(true);
  });

  it("preserves an unresolved accepted prediction past grace and across a reclaimer restart", async () => {
    await writeBulk();
    const interactionFence = vi.fn(async () => undefined);
    const clipFence = vi.fn(async () => undefined);
    const liveTarget = unresolvedPredictionTarget({ interactionFence });
    const first = await reclaimerWith("2026-07-20T18:45:00.000Z", {
      fenceClipWritesAndDrain: clipFence,
    });

    await expect(
      first.reclaimer.reclaimIfEligible(liveTarget),
    ).resolves.toEqual(
      expect.objectContaining({
        premiereId: PREMIERE_ID,
        reclaimed: false,
        reason: "prediction_resolution_pending",
        pointer: null,
        deletedBulk: false,
      }),
    );

    // A fresh reclaimer instance represents the next-process sweep. The
    // unresolved private consequence remains retryable; no irreversible fence,
    // pointer, promotion, or bulk deletion is allowed in either process.
    const restarted = await reclaimerWith("2026-07-20T19:45:00.000Z", {
      fenceClipWritesAndDrain: clipFence,
    });
    await expect(
      restarted.reclaimer.reclaimIfEligible(liveTarget),
    ).resolves.toMatchObject({
      reclaimed: false,
      reason: "prediction_resolution_pending",
      pointer: null,
      deletedBulk: false,
    });
    expect(interactionFence).not.toHaveBeenCalled();
    expect(clipFence).not.toHaveBeenCalled();
    expect(first.store.lookup(PREMIERE_ID)).toBeNull();
    expect(restarted.store.lookup(PREMIERE_ID)).toBeNull();
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);
    expect(await exists(runtimeSnapshotPath(PREMIERE_ID))).toBe(true);
    expect(await exists(interactionSnapshotPath(PREMIERE_ID))).toBe(true);
  });

  it("does not finish an existing-pointer retry while its private prediction outcome is unresolved", async () => {
    await writeBulk();
    const interactionFence = vi.fn(async () => undefined);
    const clipFence = vi.fn(async () => undefined);
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
      { fenceClipWritesAndDrain: clipFence },
    );
    const summary = (
      await import("../../../src/server/replay-premiere/ReplayPremiereResultSummary")
    ).buildPremiereResultSummaryFromTarget({
      target: target(),
      terminalState: "revealed",
      reclaimedAt: "2026-07-20T18:45:00.000Z",
    });
    const pointer = await store.recordReclaimed(summary, SOURCE_SHA);

    await expect(
      reclaimer.reclaimIfEligible(
        unresolvedPredictionTarget({ interactionFence }),
      ),
    ).resolves.toMatchObject({
      reclaimed: false,
      reason: "prediction_resolution_pending",
      pointer,
      deletedBulk: false,
    });
    expect(interactionFence).not.toHaveBeenCalled();
    expect(clipFence).not.toHaveBeenCalled();
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);
    expect(await exists(runtimeSnapshotPath(PREMIERE_ID))).toBe(true);
    expect(await exists(interactionSnapshotPath(PREMIERE_ID))).toBe(true);
  });

  it("never reclaims an excluded premiere, even past grace", async () => {
    await writeBulk();
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const reclaimer = new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store,
      graceMs: GRACE_MS,
      now: () => new Date("2026-07-20T18:45:00.000Z"), // well past grace
      excludedPremiereIds: [PREMIERE_ID],
    });
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(false);
    expect(result.reason).toBe("excluded");
    // Nothing was touched: no pointer, and every bulk artifact is intact so the
    // premiere stays fully served.
    expect(store.lookup(PREMIERE_ID)).toBeNull();
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);
    expect(await exists(sourcePath())).toBe(true);
    expect(await exists(runtimeSnapshotPath(PREMIERE_ID))).toBe(true);
    expect(await exists(interactionSnapshotPath(PREMIERE_ID))).toBe(true);
  });

  it("writes the summary + pointer, then deletes the bulk, keeping the summary", async () => {
    await writeBulk();
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z", // 45 minutes after reveal > grace
    );
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(result.reason).toBe("reclaimed");

    // Durable summary + pointer were committed BEFORE deletion.
    expect(store.lookup(PREMIERE_ID)).not.toBeNull();
    const summary = await store.loadSummary(PREMIERE_ID);
    expect(summary?.terminalState).toBe("revealed");
    expect(
      await exists(
        path.join(
          root,
          "archive-v1",
          "summaries",
          `${PREMIERE_ID}.summary.json`,
        ),
      ),
    ).toBe(true);

    // Per-premiere-private bulk is gone: admission + both snapshots. The SHARED,
    // content-addressed source survives the concurrent live sweep and is
    // reclaimed only at startup (no live writer) — see the startup-GC test below.
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
    expect(await exists(sourcePath())).toBe(true);
    expect(await exists(runtimeSnapshotPath(PREMIERE_ID))).toBe(false);
    expect(await exists(interactionSnapshotPath(PREMIERE_ID))).toBe(false);
  });

  it("fences live writes, drains an admitted reaction into the summary, and rejects later writes", async () => {
    await writeBulk();
    let releaseClipDrain!: () => void;
    const clipDrainGate = new Promise<void>((resolve) => {
      releaseClipDrain = resolve;
    });
    let clipFenceCalled = false;
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
      {
        fenceClipWritesAndDrain: (premiereId) => {
          expect(premiereId).toBe(PREMIERE_ID);
          clipFenceCalled = true;
          return clipDrainGate;
        },
      },
    );
    let releaseReactionPersist!: () => void;
    const reactionPersistGate = new Promise<void>((resolve) => {
      releaseReactionPersist = resolve;
    });
    let markReactionPersistStarted!: () => void;
    const reactionPersistStarted = new Promise<void>((resolve) => {
      markReactionPersistStarted = resolve;
    });
    const interactions = terminalInteractions(async (eventType) => {
      if (eventType === "reaction_submitted") {
        markReactionPersistStarted();
        await reactionPersistGate;
      }
    });
    const participantId = `guest_${"a".repeat(32)}`;
    const requesterBucketId = `ip_${"1".repeat(64)}`;
    const session = await interactions.createViewerSession({
      participantId,
      idempotencyKey: "session_before_fence_0001",
      requesterBucketId,
      visible: true,
      observedSequence: 5,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    const admittedReaction = interactions.submitReaction({
      participantId,
      sessionId: session.id,
      idempotencyKey: "reaction_before_fence001",
      requesterBucketId,
      sequence: 5,
      kind: "smart",
    });
    await reactionPersistStarted;

    const liveTarget = {
      ...target(),
      interactions,
    } as ReplayPremiereHttpTarget;
    const reclamation = reclaimer.reclaimIfEligible(liveTarget);
    // Both admission fences are entered synchronously before either drain is
    // awaited; a slow interaction persistence never leaves clip admission open.
    expect(clipFenceCalled).toBe(true);

    // The reclaimer has fenced synchronously, but cannot take its summary
    // snapshot or write the pointer until the already-admitted persistence
    // finishes.
    await expect(
      interactions.submitReaction({
        participantId,
        sessionId: session.id,
        idempotencyKey: "reaction_after_fence0001",
        requesterBucketId,
        sequence: 6,
        kind: "mistake",
      }),
    ).rejects.toMatchObject({
      httpStatus: 410,
      operatorCode: "interaction_writes_fenced",
    });
    expect(store.lookup(PREMIERE_ID)).toBeNull();
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);

    releaseReactionPersist();
    await admittedReaction;
    await Promise.resolve();
    expect(store.lookup(PREMIERE_ID)).toBeNull();
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);
    releaseClipDrain();
    const result = await reclamation;
    expect(result.reason).toBe("reclaimed");
    expect((await store.loadSummary(PREMIERE_ID))?.markers).toEqual([
      { kind: "smart", turn: 5, count: 1 },
    ]);
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
    expect(await exists(interactionSnapshotPath(PREMIERE_ID))).toBe(false);
  });

  it("defers shared-source deletion to the startup GC (unreferenced only)", async () => {
    await writeBulk();
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
    );
    await reclaimer.reclaimIfEligible(target());
    // The live sweep never deletes the shared source.
    expect(await exists(sourcePath())).toBe(true);

    // Startup GC keeps a source a surviving admission still references...
    const kept = await reclaimUnreferencedPremiereSources({
      privateStateRoot: root,
      reclaimedSources: store.reclaimedSources(),
      presentSourceShas: [SOURCE_SHA],
    });
    expect(kept.removed).toEqual([]);
    expect(await exists(sourcePath())).toBe(true);

    // ...and deletes it once no admission references it.
    const removed = await reclaimUnreferencedPremiereSources({
      privateStateRoot: root,
      reclaimedSources: store.reclaimedSources(),
      presentSourceShas: [],
    });
    expect(removed.removed).toEqual([SOURCE_SHA]);
    expect(await exists(sourcePath())).toBe(false);
  });

  it("is idempotent and finishes deletion after a crash between pointer and delete", async () => {
    await writeBulk();
    const { store } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    // Simulate a crash right after the pointer was committed but before the bulk
    // was deleted: the pointer exists, the admission is still on disk.
    const summary = (
      await import("../../../src/server/replay-premiere/ReplayPremiereResultSummary")
    ).buildPremiereResultSummaryFromTarget({
      target: target(),
      terminalState: "revealed",
      reclaimedAt: "2026-07-20T18:45:00.000Z",
    });
    await store.recordReclaimed(summary, SOURCE_SHA);
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);

    // A restart re-assembles the (still-admitted) premiere; the sweep re-runs.
    const reopened = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const reclaimer = new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store: reopened,
      graceMs: GRACE_MS,
      now: () => new Date("2026-07-20T18:46:00.000Z"),
    });
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(result.reason).toBe("already_reclaimed");
    // Deletion completed on the retry; the summary is preserved throughout.
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
    expect(await reopened.loadSummary(PREMIERE_ID)).toEqual(summary);
  });

  it("fences and drains an existing-pointer live retry before deleting bulk", async () => {
    await writeBulk();
    let blockSessionPersist = false;
    let releaseSessionPersist!: () => void;
    const sessionPersistGate = new Promise<void>((resolve) => {
      releaseSessionPersist = resolve;
    });
    let markSessionPersistStarted!: () => void;
    const sessionPersistStarted = new Promise<void>((resolve) => {
      markSessionPersistStarted = resolve;
    });
    const interactions = terminalInteractions(async (eventType) => {
      if (blockSessionPersist && eventType === "viewer_session_started") {
        markSessionPersistStarted();
        await sessionPersistGate;
      }
    });
    const liveTarget = {
      ...target(),
      interactions,
    } as ReplayPremiereHttpTarget;
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
    );
    const summary = (
      await import("../../../src/server/replay-premiere/ReplayPremiereResultSummary")
    ).buildPremiereResultSummaryFromTarget({
      target: liveTarget,
      terminalState: "revealed",
      reclaimedAt: "2026-07-20T18:45:00.000Z",
    });
    await store.recordReclaimed(summary, SOURCE_SHA);

    blockSessionPersist = true;
    const admittedSession = interactions.createViewerSession({
      participantId: `guest_${"a".repeat(32)}`,
      idempotencyKey: "existing_pointer_session01",
      requesterBucketId: `ip_${"1".repeat(64)}`,
      visible: true,
      observedSequence: 5,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    await sessionPersistStarted;
    const retry = reclaimer.reclaimIfEligible(liveTarget);

    await expect(
      interactions.createViewerSession({
        participantId: `guest_${"b".repeat(32)}`,
        idempotencyKey: "existing_pointer_session02",
        requesterBucketId: `ip_${"2".repeat(64)}`,
        visible: true,
        observedSequence: 5,
        excludedAsOperator: false,
        excludedAsBot: false,
      }),
    ).rejects.toMatchObject({
      httpStatus: 410,
      operatorCode: "interaction_writes_fenced",
    });
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);

    releaseSessionPersist();
    await admittedSession;
    const result = await retry;
    expect(result.reason).toBe("already_reclaimed");
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
    expect(await store.loadSummary(PREMIERE_ID)).toEqual(summary);
  });

  it("refuses existing-pointer bulk deletion when recovered reactions diverge from the immutable summary", async () => {
    await writeBulk();
    const interactions = terminalInteractions();
    const liveTarget = {
      ...target(),
      interactions,
    } as ReplayPremiereHttpTarget;
    const participantId = `guest_${"a".repeat(32)}`;
    const requesterBucketId = `ip_${"1".repeat(64)}`;
    const session = await interactions.createViewerSession({
      participantId,
      idempotencyKey: "divergence_session_0001",
      requesterBucketId,
      visible: true,
      observedSequence: 5,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
    );
    const archivedSummary = (
      await import("../../../src/server/replay-premiere/ReplayPremiereResultSummary")
    ).buildPremiereResultSummaryFromTarget({
      target: liveTarget,
      terminalState: "revealed",
      reclaimedAt: "2026-07-20T18:45:00.000Z",
    });
    const archivedPointer = await store.recordReclaimed(
      archivedSummary,
      SOURCE_SHA,
    );
    await interactions.submitReaction({
      participantId,
      sessionId: session.id,
      idempotencyKey: "divergence_reaction_0001",
      requesterBucketId,
      sequence: 5,
      kind: "smart",
    });

    await expect(reclaimer.reclaimIfEligible(liveTarget)).rejects.toMatchObject(
      {
        operatorCode: "reclamation_archived_summary_state_diverged",
      },
    );
    expect(store.lookup(PREMIERE_ID)).toEqual(archivedPointer);
    expect((await store.loadSummary(PREMIERE_ID))?.markers).toEqual([]);
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);
    expect(await exists(interactionSnapshotPath(PREMIERE_ID))).toBe(true);
    await expect(
      interactions.createViewerSession({
        participantId: `guest_${"b".repeat(32)}`,
        idempotencyKey: "divergence_session_0002",
        requesterBucketId: `ip_${"2".repeat(64)}`,
        visible: true,
        observedSequence: 6,
        excludedAsOperator: false,
        excludedAsBot: false,
      }),
    ).rejects.toMatchObject({
      httpStatus: 410,
      operatorCode: "interaction_writes_fenced",
    });
  });
});

describe("durable archived-clip promotion", () => {
  const archivedClipPath = (premiereId: string): string =>
    path.join(root, "archive-v1", "clips", `${premiereId}.mp4`);
  const archivedClipManifestPath = (premiereId: string): string =>
    path.join(
      root,
      "archive-v1",
      "clips",
      `${premiereId}.render-manifest.json`,
    );

  async function writeCachedClip(
    premiereId: string,
    bucket: number,
    anchorTurn: number,
    bytes: Buffer,
    manifestOverrides: {
      sourceReplaySha256?: string;
      outSha256?: string;
      outBytes?: number;
    } = {},
  ): Promise<void> {
    const dir = path.join(root, "clips-v1", premiereId);
    await fs.mkdir(dir, { recursive: true });
    const clipPath = path.join(dir, `clip-v1-${bucket}.mp4`);
    await fs.writeFile(clipPath, bytes);
    await fs.writeFile(
      path.join(dir, `clip-v1-${bucket}.render-manifest.json`),
      JSON.stringify({
        premiereId,
        sourceReplaySha256: manifestOverrides.sourceReplaySha256 ?? SOURCE_SHA,
        anchorTurn,
        clipVersion: 1,
        frameShape: "square",
        frameWidth: 1080,
        frameHeight: 1080,
        outSha256: manifestOverrides.outSha256 ?? sha256Hex(bytes),
        outBytes: manifestOverrides.outBytes ?? bytes.length,
        generatedAt: "2026-07-20T18:00:01.000Z",
      }),
    );
  }

  it("promotes the highest-anchor cached clip into archive-v1/clips before deleting bulk", async () => {
    await writeBulk();
    const early = Buffer.alloc(90, 1);
    const late = Buffer.alloc(120, 2);
    await writeCachedClip(PREMIERE_ID, 3, 35, early);
    await writeCachedClip(PREMIERE_ID, 61, 615, late);
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
    );
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(store.lookup(PREMIERE_ID)).not.toBeNull();

    // The durable clip is the reveal-payoff (highest anchor) render, with its
    // provenance sidecar, and the per-premiere bulk is still deleted.
    expect(await fs.readFile(archivedClipPath(PREMIERE_ID))).toEqual(late);
    expect(await exists(archivedClipManifestPath(PREMIERE_ID))).toBe(true);
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
  });

  it("reclaims normally when the premiere has no cached clip", async () => {
    await writeBulk();
    const { reclaimer } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(await exists(archivedClipPath(PREMIERE_ID))).toBe(false);
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
  });

  it("never promotes a cached clip whose source hash disagrees with the archive pointer", async () => {
    await writeBulk();
    await writeCachedClip(PREMIERE_ID, 61, 615, Buffer.alloc(64, 3), {
      sourceReplaySha256: sha256Hex("foreign-source-bundle"),
    });
    const { reclaimer } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    const result = await reclaimer.reclaimIfEligible(target());

    expect(result.reclaimed).toBe(true);
    expect(result.pointer?.sourceReplaySha256).toBe(SOURCE_SHA);
    expect(await exists(archivedClipPath(PREMIERE_ID))).toBe(false);
    expect(await exists(archivedClipManifestPath(PREMIERE_ID))).toBe(false);
  });

  it("never promotes same-size clip bytes whose hash disagrees with the manifest", async () => {
    await writeBulk();
    const bytes = Buffer.alloc(64, 4);
    await writeCachedClip(PREMIERE_ID, 61, 615, bytes, {
      outSha256: sha256Hex(Buffer.alloc(bytes.length, 5)),
    });
    const { reclaimer } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    const result = await reclaimer.reclaimIfEligible(target());

    expect(result.reclaimed).toBe(true);
    expect(await exists(archivedClipPath(PREMIERE_ID))).toBe(false);
    expect(await exists(archivedClipManifestPath(PREMIERE_ID))).toBe(false);
  });

  it("never promotes a clip for a premiere that was not reveal-public", async () => {
    const failedId = "prem_failednoclip0001";
    await writeBulk(failedId);
    // Even a (hand-planted) cache entry must not surface for a failed
    // premiere: the durable clip is reveal-public-only, exactly like the
    // summary outcome.
    await writeCachedClip(failedId, 61, 615, Buffer.alloc(64, 3));
    const failedTarget = {
      runtime: {
        premiereId: failedId,
        readLifecycleState: () => "failed",
        readBootstrap: () => ({
          premiereId: failedId,
          publicationCommitmentHash: COMMITMENT,
          provenance: {
            sourceKind: "controlled_exhibition",
            sourceRunId: "controlled-run-002",
            sourceReplaySha256: SOURCE_SHA,
            seats: seatFixtures(),
          },
        }),
        readReveal: () => null,
      },
      interactions: {
        readCheckpoints: () => [],
        readState: () => emptyInteractionSnapshot(failedId),
        fenceWritesAndDrain: async () => undefined,
      },
    } as unknown as ReplayPremiereHttpTarget;
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
    );
    const result = await reclaimer.reclaimIfEligible(failedTarget);
    expect(result.reclaimed).toBe(true);
    expect(store.lookup(failedId)?.terminalState).toBe("failed");
    expect(await exists(archivedClipPath(failedId))).toBe(false);
    expect(await exists(archivedClipManifestPath(failedId))).toBe(false);
  });

  it("adopts the first durable clip verbatim on the already-reclaimed retry", async () => {
    await writeBulk();
    const original = Buffer.alloc(80, 4);
    await writeCachedClip(PREMIERE_ID, 61, 615, original);
    const { reclaimer } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    await reclaimer.reclaimIfEligible(target());
    expect(await fs.readFile(archivedClipPath(PREMIERE_ID))).toEqual(original);

    // A different cache clip appearing later must never replace the durable
    // artifact (first write wins, matching summary adoption semantics).
    await writeCachedClip(PREMIERE_ID, 70, 705, Buffer.alloc(70, 5));
    const again = await reclaimer.reclaimIfEligible(target());
    expect(again.reason).toBe("already_reclaimed");
    expect(await fs.readFile(archivedClipPath(PREMIERE_ID))).toEqual(original);
  });

  it("ignores cache artifacts whose sidecar is missing, foreign, or size-mismatched", async () => {
    await writeBulk();
    const dir = path.join(root, "clips-v1", PREMIERE_ID);
    await fs.mkdir(dir, { recursive: true });
    // No sidecar at all.
    await fs.writeFile(path.join(dir, "clip-v1-10.mp4"), Buffer.alloc(10, 6));
    // Sidecar bytes disagree with the file (torn write).
    const torn = Buffer.alloc(50, 7);
    await writeCachedClip(PREMIERE_ID, 20, 205, torn);
    await fs.writeFile(path.join(dir, "clip-v1-20.mp4"), Buffer.alloc(49, 7));
    const { reclaimer } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(await exists(archivedClipPath(PREMIERE_ID))).toBe(false);
  });

  it("bounds durable clip storage by count with oldest-first eviction", async () => {
    const ids = [
      "prem_retention0000001",
      "prem_retention0000002",
      "prem_retention0000003",
    ] as const;
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const reclaimer = new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store,
      graceMs: GRACE_MS,
      now: () => new Date("2026-07-20T18:45:00.000Z"),
      maxArchivedClips: 2,
    });
    for (const [index, premiereId] of ids.entries()) {
      await writeCachedClip(premiereId, 61, 615, Buffer.alloc(30 + index, 9));
      await reclaimer.reclaimIfEligible(target(premiereId));
      // Backdate so eviction ordering is deterministic even within one tick.
      const when = new Date(
        Date.parse("2026-07-01T00:00:00Z") + index * 60_000,
      );
      await fs.utimes(archivedClipPath(premiereId), when, when);
    }
    expect(await exists(archivedClipPath(ids[0]))).toBe(false);
    // Provenance sidecars are monotonic so a concurrent re-link can never
    // expose an MP4 after eviction without its matching manifest.
    expect(await exists(archivedClipManifestPath(ids[0]))).toBe(true);
    expect(await exists(archivedClipPath(ids[1]))).toBe(true);
    expect(await exists(archivedClipPath(ids[2]))).toBe(true);
  });

  it("preserves retry state when retention cannot unlink an old MP4, then converges on retry", async () => {
    const firstId = "prem_retryretain000001";
    const secondId = "prem_retryretain000002";
    const logs: string[] = [];
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const reclaimer = new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store,
      graceMs: GRACE_MS,
      now: () => new Date("2026-07-20T18:45:00.000Z"),
      maxArchivedClips: 1,
      logger: (message) => logs.push(message),
    });
    await writeBulk(firstId);
    await writeCachedClip(firstId, 61, 615, Buffer.alloc(40, 1));
    await reclaimer.reclaimIfEligible(target(firstId));
    const old = new Date("2026-07-01T00:00:00.000Z");
    await fs.utimes(archivedClipPath(firstId), old, old);

    await writeBulk(secondId);
    await writeCachedClip(secondId, 61, 615, Buffer.alloc(41, 2));
    const originalUnlink = fs.unlink.bind(fs);
    const unlinkFailure = Object.assign(new Error("injected unlink failure"), {
      code: "EACCES",
    });
    const unlinkSpy = vi
      .spyOn(fs, "unlink")
      .mockImplementation(async (file) => {
        if (path.resolve(String(file)) === archivedClipPath(firstId)) {
          throw unlinkFailure;
        }
        await originalUnlink(file);
      });
    try {
      await expect(reclaimer.reclaimIfEligible(target(secondId))).rejects.toBe(
        unlinkFailure,
      );
    } finally {
      unlinkSpy.mockRestore();
    }

    // The failed eviction was never reported/accounted as success, its
    // sidecar remains, and the newly archived premiere retains every bulk
    // artifact needed for the existing-pointer retry.
    expect(logs).not.toContain(`archived_clip_evicted ${firstId} retention`);
    expect(await exists(archivedClipPath(firstId))).toBe(true);
    expect(await exists(archivedClipManifestPath(firstId))).toBe(true);
    expect(await exists(admissionPath(secondId))).toBe(true);
    expect(await exists(runtimeSnapshotPath(secondId))).toBe(true);
    expect(await exists(interactionSnapshotPath(secondId))).toBe(true);

    const retry = new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store,
      graceMs: GRACE_MS,
      now: () => new Date("2026-07-20T18:46:00.000Z"),
      maxArchivedClips: 1,
      logger: (message) => logs.push(message),
    });
    const result = await retry.reclaimIfEligible(target(secondId));
    expect(result.reason).toBe("already_reclaimed");
    expect(await exists(archivedClipPath(firstId))).toBe(false);
    expect(await exists(archivedClipManifestPath(firstId))).toBe(true);
    expect(await exists(archivedClipPath(secondId))).toBe(true);
    expect(await exists(admissionPath(secondId))).toBe(false);
    expect(logs).toContain(`archived_clip_evicted ${firstId} retention`);
  });
});

describe("loadReplayPremiereReclamationExclusions", () => {
  it("merges the env var and the pin file, dropping malformed ids", async () => {
    await fs.writeFile(
      path.join(root, "reclaim-exclude.txt"),
      "# release-proof premieres\nprem_excludepin000001\n\nnot-a-premiere\n",
    );
    const excluded = await loadReplayPremiereReclamationExclusions({
      privateStateRoot: root,
      env: {
        PROXYWAR_PREMIERE_RECLAIM_EXCLUDE:
          "prem_excludeenv000001, prem_excludeenv000002 ,garbage",
      },
    });
    expect(excluded).toEqual(
      [
        "prem_excludeenv000001",
        "prem_excludeenv000002",
        "prem_excludepin000001",
      ].sort(),
    );
  });

  it("returns an empty set with no env and no pin file", async () => {
    expect(
      await loadReplayPremiereReclamationExclusions({
        privateStateRoot: root,
        env: {},
      }),
    ).toEqual([]);
  });
});
