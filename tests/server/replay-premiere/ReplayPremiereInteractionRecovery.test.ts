import { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ReplayPremiereEventStore } from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import {
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  loadReplayPremiereInteractions,
  type ReplayPremiereInteractionEventStore,
  type ReplayPremiereRecoveredInteractionsOptions,
} from "../../../src/server/replay-premiere/ReplayPremiereInteractionRecovery";
import type { ReplayPremiereInteractionCheckpoint } from "../../../src/server/replay-premiere/ReplayPremiereInteractions";

const PREMIERE_ID = "prem_abcdefghijklmnop";
const PARTICIPANT_ID = `guest_${"a".repeat(32)}`;
const NOW = "2026-07-20T12:00:00.000Z";

describe("ReplayPremiereInteractionRecovery", () => {
  let root: string;
  let privateRoot: string;
  let servedRoot: string;
  const stores: ReplayPremiereEventStore[] = [];

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(
      path.join(realTemporaryRoot, "premiere-interaction-recovery-"),
    );
    privateRoot = path.join(root, "private");
    servedRoot = path.join(root, "served");
    await fs.mkdir(servedRoot);
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("replays an accepted audience event after a crash before snapshot publication", async () => {
    let failSnapshotSync = true;
    const firstStore = await openStore({
      snapshotSync: async (handle) => {
        if (failSnapshotSync) {
          failSnapshotSync = false;
          throw new Error("injected interaction snapshot crash");
        }
        await handle.sync();
      },
    });
    stores.push(firstStore);
    const first = await loadReplayPremiereInteractions({
      eventStore: firstStore,
      interactions: interactionOptions(),
    });

    await expect(
      first.interactions.createViewerSession({
        participantId: PARTICIPANT_ID,
        idempotencyKey: "idem_recovery_crash_0001",
        requesterBucketId: `ip_${"1".repeat(32)}`,
        visible: true,
        observedSequence: -1,
        excludedAsOperator: false,
        excludedAsBot: false,
      }),
    ).rejects.toThrow("injected interaction snapshot crash");
    expect(first.interactions.readState().sessions).toHaveLength(0);
    expect(firstStore.recovered.events).toHaveLength(1);

    const restartedStore = await openStore();
    stores.push(restartedStore);
    const restarted = await loadReplayPremiereInteractions({
      eventStore: restartedStore,
      interactions: interactionOptions(),
    });

    expect(restarted.interactions.readState().sessions).toEqual([
      expect.objectContaining({
        participantId: PARTICIPANT_ID,
        idempotencyKey: "idem_recovery_crash_0001",
      }),
    ]);
    expect(restarted.recovery).toMatchObject({
      eventCursor: 0,
      stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("keeps later accepted audience state when a runtime checkpoint append crashes before in-memory commit", async () => {
    const firstStore = await openStore();
    stores.push(firstStore);
    const first = await loadReplayPremiereInteractions({
      eventStore: firstStore,
      interactions: interactionOptions(),
    });
    await appendRuntimeCheckpointEvent(
      firstStore,
      "premiere_runtime_initialized",
      first.interactions.readState().checkpoints,
      "runtime:init:recovery-test",
    );
    const session = await first.interactions.createViewerSession({
      participantId: PARTICIPANT_ID,
      idempotencyKey: "idem_before_runtime_crash_1",
      requesterBucketId: `ip_${"2".repeat(32)}`,
      visible: true,
      observedSequence: -1,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    const closesAt = new Date(Date.parse(NOW) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS).toISOString();
    const prepared = first.interactions.prepareOpenCheckpoint({
      checkpointId: "cp_first0001",
      opensAt: NOW,
      closesAt,
      optionSeatIds: ["seat-1", "SEAT0001"],
    });
    await appendRuntimeCheckpointEvent(
      firstStore,
      "premiere_runtime_chunk_released",
      prepared.nextState.checkpoints,
      "runtime:checkpoint-open:recovery-test",
    );
    // Simulated process death: the runtime event is durable, but the prepared
    // in-memory transition is deliberately never committed.
    await firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const restartedStore = await openStore();
    stores.push(restartedStore);
    const restarted = await loadReplayPremiereInteractions({
      eventStore: restartedStore,
      interactions: interactionOptions(),
    });
    const recovered = restarted.interactions.readState();

    expect(recovered.sessions).toEqual([
      expect.objectContaining({
        id: session.id,
        participantId: PARTICIPANT_ID,
      }),
    ]);
    expect(recovered.checkpoints[0]).toMatchObject({
      id: "cp_first0001",
      state: "open",
      opensAt: NOW,
      closesAt,
    });
    expect(recovered.checkpoints[1].state).toBe("upcoming");
    expect(restarted.recovery.eventCursor).toBe(2);
  });

  test("anchors a normal write after a runtime checkpoint without duplicating checkpoint authority", async () => {
    const firstStore = await openStore();
    stores.push(firstStore);
    const first = await loadReplayPremiereInteractions({
      eventStore: firstStore,
      interactions: interactionOptions(),
    });
    await appendRuntimeCheckpointEvent(
      firstStore,
      "premiere_runtime_initialized",
      first.interactions.readState().checkpoints,
      "runtime:init:post-runtime-write",
    );
    const closesAt = new Date(Date.parse(NOW) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS).toISOString();
    const prepared = first.interactions.prepareOpenCheckpoint({
      checkpointId: "cp_first0001",
      opensAt: NOW,
      closesAt,
      optionSeatIds: ["seat-1", "SEAT0001"],
    });
    await appendRuntimeCheckpointEvent(
      firstStore,
      "premiere_runtime_chunk_released",
      prepared.nextState.checkpoints,
      "runtime:checkpoint-open:post-runtime-write",
    );
    prepared.commit();
    const session = await first.interactions.createViewerSession({
      participantId: PARTICIPANT_ID,
      idempotencyKey: "idem_after_runtime_event_001",
      requesterBucketId: `ip_${"3".repeat(32)}`,
      visible: true,
      observedSequence: -1,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    await firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const restartedStore = await openStore();
    stores.push(restartedStore);
    const restarted = await loadReplayPremiereInteractions({
      eventStore: restartedStore,
      interactions: interactionOptions(),
    });

    expect(restarted.interactions.readState()).toMatchObject({
      sessions: [{ id: session.id }],
      checkpoints: [{ state: "open", closesAt }, { state: "upcoming" }],
    });
    expect(restarted.recovery.eventCursor).toBe(2);
  });

  test("advances an idempotent repair to the current global tip after a cross-aggregate append", async () => {
    const store = await openStore();
    stores.push(store);
    let throwAfterFirstInteractionCommit = true;
    const throwingView: ReplayPremiereInteractionEventStore = {
      get recovered() {
        return store.recovered;
      },
      readRecoveryView: (aggregateId) => store.readRecoveryView(aggregateId),
      appendAndSnapshot: async (options) => {
        const accepted = await store.appendAndSnapshot(options);
        if (
          throwAfterFirstInteractionCommit &&
          options.event.aggregateId.startsWith("interaction:")
        ) {
          throwAfterFirstInteractionCommit = false;
          throw new Error("injected throw after durable interaction commit");
        }
        return accepted;
      },
    };
    const loaded = await loadReplayPremiereInteractions({
      eventStore: throwingView,
      interactions: interactionOptions({ fixedRandom: true }),
    });
    const request = {
      participantId: PARTICIPANT_ID,
      idempotencyKey: "idem_cross_aggregate_retry_1",
      requesterBucketId: `ip_${"4".repeat(32)}`,
      visible: true,
      observedSequence: -1,
      excludedAsOperator: false,
      excludedAsBot: false,
    } as const;
    await expect(
      loaded.interactions.createViewerSession(request),
    ).rejects.toThrow("injected throw after durable interaction commit");
    expect(store.recovered.lastEventSequence).toBe(0);
    await appendRuntimeCheckpointEvent(
      store,
      "premiere_runtime_initialized",
      loaded.interactions.readState().checkpoints,
      "runtime:init:cross-aggregate-retry",
    );
    expect(store.recovered.lastEventSequence).toBe(1);

    await expect(
      loaded.interactions.createViewerSession(request),
    ).resolves.toMatchObject({ participantId: PARTICIPANT_ID });
    expect(loaded.persistence.recoveryAnchor().eventCursor).toBe(1);

    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const restartedStore = await openStore();
    stores.push(restartedStore);
    const restarted = await loadReplayPremiereInteractions({
      eventStore: restartedStore,
      interactions: interactionOptions({ fixedRandom: true }),
    });
    expect(restarted.recovery.eventCursor).toBe(1);
    expect(restarted.interactions.readState().sessions).toHaveLength(1);
  });

  test("reads snapshot and global event tip from one serialized recovery boundary", async () => {
    let releaseSnapshot!: () => void;
    let snapshotSyncEntered!: () => void;
    const snapshotMayFinish = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshotStarted = new Promise<void>((resolve) => {
      snapshotSyncEntered = resolve;
    });
    const store = await openStore({
      snapshotSync: async (handle) => {
        snapshotSyncEntered();
        await snapshotMayFinish;
        await handle.sync();
      },
    });
    stores.push(store);
    const first = await loadReplayPremiereInteractions({
      eventStore: store,
      interactions: interactionOptions(),
    });
    const write = first.interactions.createViewerSession({
      participantId: PARTICIPANT_ID,
      idempotencyKey: "idem_atomic_recovery_view_1",
      requesterBucketId: `ip_${"5".repeat(32)}`,
      visible: true,
      observedSequence: -1,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    await snapshotStarted;
    const concurrentRecovery = loadReplayPremiereInteractions({
      eventStore: store,
      interactions: interactionOptions(),
    });
    releaseSnapshot();

    await expect(write).resolves.toBeDefined();
    const recovered = await concurrentRecovery;
    expect(recovered.recovery.eventCursor).toBe(0);
    expect(recovered.interactions.readState().sessions).toEqual([
      expect.objectContaining({
        participantId: PARTICIPANT_ID,
        idempotencyKey: "idem_atomic_recovery_view_1",
      }),
    ]);
  });

  test("rejects a valid forged snapshot that is not the anchoring event's committed state", async () => {
    const store = await openStore();
    stores.push(store);
    const loaded = await loadReplayPremiereInteractions({
      eventStore: store,
      interactions: interactionOptions(),
    });
    const emptyState = loaded.interactions.readState();
    await loaded.interactions.createViewerSession({
      participantId: PARTICIPANT_ID,
      idempotencyKey: "idem_snapshot_commitment_001",
      requesterBucketId: `ip_${"6".repeat(32)}`,
      visible: true,
      observedSequence: -1,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    const snapshotPath = path.join(
      store.snapshotsDirectory,
      `interaction:${PREMIERE_ID}.snapshot.json`,
    );
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const snapshot = JSON.parse(
      await fs.readFile(snapshotPath, "utf8"),
    ) as Record<string, ReplayPremiereJsonValue>;
    snapshot.state = JSON.parse(JSON.stringify(emptyState));
    snapshot.stateHash = hashReplayPremiereJson(snapshot.state);
    await fs.writeFile(
      snapshotPath,
      `${canonicalReplayPremiereJson(snapshot)}\n`,
      { mode: 0o600 },
    );

    const restartedStore = await openStore();
    stores.push(restartedStore);
    await expect(
      loadReplayPremiereInteractions({
        eventStore: restartedStore,
        interactions: interactionOptions(),
      }),
    ).rejects.toMatchObject({
      operatorCode: "interaction_snapshot_commitment_mismatch",
    });
  });

  async function openStore(
    overrides: Partial<
      Parameters<typeof ReplayPremiereEventStore.open>[0]
    > = {},
  ): Promise<ReplayPremiereEventStore> {
    return ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits: {
        maxEventBytes: 500_000,
        maxAggregateEventBytes: 5_000_000,
        maxEventLogBytes: 10_000_000,
        maxSnapshotBytes: 2_000_000,
        maxPrivateStateBytes: 20_000_000,
      },
      ...overrides,
    });
  }
});

function interactionOptions(
  options: { fixedRandom?: boolean } = {},
): ReplayPremiereRecoveredInteractionsOptions {
  let randomValue = 1;
  return {
    premiereId: PREMIERE_ID,
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
    getPremiereState: () => "playing",
    getReleasedContext: (sequence) =>
      sequence <= 80
        ? {
            releasedThroughSequence: 80,
            turn: sequence,
            eventContext: { sequence },
          }
        : null,
    signAttribution: () => "a".repeat(64),
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${PREMIERE_ID}`,
    now: () => new Date(NOW),
    randomBytes: (size) => {
      const bytes = new Uint8Array(size).fill(randomValue);
      if (!options.fixedRandom) randomValue += 1;
      return bytes;
    },
    admitAnonymousWrite: () => undefined,
  };
}

async function appendRuntimeCheckpointEvent(
  store: ReplayPremiereEventStore,
  eventType: string,
  checkpoints: readonly ReplayPremiereInteractionCheckpoint[],
  idempotencyKey: string,
): Promise<void> {
  const state: ReplayPremiereJsonValue = JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      premiereId: PREMIERE_ID,
      interactionCheckpoints: checkpoints,
    }),
  );
  await store.appendAndSnapshot({
    event: {
      aggregateId: PREMIERE_ID,
      eventType,
      occurredAt: NOW,
      payload: state,
    },
    state,
    idempotencyKey,
  });
}
