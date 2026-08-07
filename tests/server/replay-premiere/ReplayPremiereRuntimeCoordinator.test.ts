import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { freezeReplayPremiereCheckpointProjection } from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import type {
  ReplayPremiereEventRecovery,
  ReplayPremiereSnapshot,
  StoredReplayPremiereEvent,
} from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import { ReplayPremiereEventStore } from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import {
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { ReplayPremiereInteractions } from "../../../src/server/replay-premiere/ReplayPremiereInteractions";
import { ReplayPremiereAtomicPublication } from "../../../src/server/replay-premiere/ReplayPremiereRevealCommit";
import {
  ReplayPremiereRuntimeCoordinator as ProductionReplayPremiereRuntimeCoordinator,
  REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
  type ReplayPremiereRuntimeClock,
  type ReplayPremiereRuntimePersistence,
} from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import { NOW, verifiedPublicationFixture } from "./ReplayPremiereFixtures";

const ReplayPremiereRuntimeCoordinator = {
  async createOrRecover(
    options: Omit<
      Parameters<
        typeof ProductionReplayPremiereRuntimeCoordinator.createOrRecover
      >[0],
      "checkpointProjection"
    >,
  ) {
    const runtime =
      await ProductionReplayPremiereRuntimeCoordinator.createOrRecover({
        ...options,
        checkpointProjection: allSeatsProjection(options.gate),
      });
    const state = interactionRuntimeState.get(options.interactions);
    if (state !== undefined) state.runtime = runtime;
    return runtime;
  },
};

const interactionRuntimeState = new WeakMap<
  ReplayPremiereInteractions,
  { runtime: ProductionReplayPremiereRuntimeCoordinator | null }
>();

class FakeClock implements ReplayPremiereRuntimeClock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  set(value: string | number): void {
    this.value = new Date(value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

describe("ReplayPremiereRuntimeCoordinator", () => {
  let root: string;
  const stores: ReplayPremiereEventStore[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-runtime-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("releases only by authoritative time, pauses exactly one checkpoint window, and reveals without a viewer read", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const interactions = createInteractions(gate, clock);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions,
    });

    expect(runtime.readLifecycleState()).toBe("scheduled");
    expect(runtime.readChunk(0)).toBeNull();
    expect(
      interactions.readState().checkpoints.map((entry) => entry.optionSeatIds),
    ).toEqual([[], []]);
    expect(
      (
        store.recovered.events[0].payload as unknown as {
          interactionCheckpoints: Array<{ optionSeatIds: string[] }>;
        }
      ).interactionCheckpoints.map((entry) => entry.optionSeatIds),
    ).toEqual([[], []]);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("playing");

    clock.advance(99);
    await runtime.synchronize();
    expect(runtime.readChunk(0)).toBeNull();
    clock.advance(1);
    const firstBoundary = await runtime.synchronize();
    expect(firstBoundary.operations).toEqual([
      "chunk_released",
      "checkpoint_opened",
    ]);
    expect(runtime.readLifecycleState()).toBe("checkpoint");
    expect(await runtime.readManifest()).toMatchObject({
      state: "checkpoint",
      releasedThroughSequence: 2,
      lastReleasedChunkIndex: 0,
    });
    expect(runtime.readChunk(1)).toBeNull();
    const checkpoint = runtime.readActiveCheckpoint();
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.optionSeatIds).toEqual(["SEAT0001", "SEAT0002"]);
    expect(interactions.readState().checkpoints[0].optionSeatIds).toEqual([
      "SEAT0001",
      "SEAT0002",
    ]);
    expect(interactions.readState().checkpoints[1].optionSeatIds).toEqual([]);
    expect(
      Date.parse(checkpoint!.closesAt) - Date.parse(checkpoint!.opensAt),
    ).toBe(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);

    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS - 1);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("checkpoint");
    expect(runtime.readChunk(1)).toBeNull();
    clock.advance(1);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("playing");
    clock.advance(99);
    await runtime.synchronize();
    expect(runtime.readChunk(1)).toBeNull();
    clock.advance(1);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("checkpoint");
    expect(await runtime.readManifest()).toMatchObject({
      releasedThroughSequence: 4,
      lastReleasedChunkIndex: 1,
    });

    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
    await runtime.synchronize();
    clock.advance(49);
    await runtime.synchronize();
    expect(runtime.readReveal()).toBeNull();
    expect(runtime.readChunk(2)).toBeNull();
    clock.advance(1);
    const terminal = await runtime.synchronize();
    expect(terminal.operations).toContain("revealed");
    expect(runtime.readLifecycleState()).toBe("revealed");
    expect(runtime.readReveal()).toMatchObject({ state: "revealed" });
    expect(
      store.recovered.events.filter(
        (event) => event.eventType === "premiere_reveal_committed",
      ),
    ).toHaveLength(1);
    expect(runtime.readChunk(2)).toMatchObject({ terminal: true });
    expect(
      interactions.readState().checkpoints.map((entry) => entry.resolution),
    ).toEqual([
      {
        kind: "winner",
        winnerSeatId: "SEAT0001",
        resolvedAt: runtime.readReveal()!.revealedAt,
      },
      {
        kind: "winner",
        winnerSeatId: "SEAT0001",
        resolvedAt: runtime.readReveal()!.revealedAt,
      },
    ]);
  });

  test("a prefix read failure before terminal reveal stays retryable", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const interactions = createInteractions(gate, clock);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions,
    });

    // Drive to the exact same terminal boundary as the sibling "releases
    // only by authoritative time..." test above: two non-terminal chunk
    // releases (index 0, index 1), each opening and closing a checkpoint,
    // then the clock tick that makes the terminal (index 2) draft eligible.
    await runtime.synchronize();
    clock.advance(100);
    await runtime.synchronize();
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 100);
    await runtime.synchronize();
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 49);
    await runtime.synchronize();
    expect(runtime.readReveal()).toBeNull();
    clock.advance(1);

    // Inject a single publication-store miss for the EARLIEST released
    // prefix chunk (index 0). At this point lastReleasedChunk() only ever
    // reads the LAST released index (1), so this exclusively exercises
    // commitTerminalReveal's own prefix-reconstruction loop, not any other
    // readChunk() call site.
    const originalReadChunk: ReplayPremiereAtomicPublication["readChunk"] =
      ReplayPremiereAtomicPublication.prototype.readChunk;
    let failNextIndexZeroRead = true;
    const readChunkSpy = vi
      .spyOn(ReplayPremiereAtomicPublication.prototype, "readChunk")
      .mockImplementation(function (
        this: ReplayPremiereAtomicPublication,
        index: number,
      ) {
        if (failNextIndexZeroRead && index === 0) {
          failNextIndexZeroRead = false;
          return null;
        }
        return originalReadChunk.call(this, index);
      });

    // First synchronize(): the injected miss aborts commitTerminalReveal.
    // Atomicity contract: the durable, point-of-no-return commitReveal()
    // must not have run yet, so nothing is publicly exposed and the
    // coordinator is left exactly where it was, still retryable.
    await expect(runtime.synchronize()).rejects.toMatchObject({
      operatorCode: "premiere_runtime_revealed_publication_prefix_missing",
    });
    expect(readChunkSpy).toHaveBeenCalledWith(0);
    expect(failNextIndexZeroRead).toBe(false);
    expect(runtime.readReveal()).toBeNull();
    expect(runtime.readLifecycleState()).toBe("playing");
    expect(
      store.recovered.events.filter(
        (event) => event.eventType === "premiere_reveal_committed",
      ),
    ).toHaveLength(0);

    // Retry: the injected failure only fires once, so the exact same
    // synchronize() call now runs the (unchanged) prefix loop successfully
    // and reaches the durable commitReveal() for the first time.
    const retried = await runtime.synchronize();
    expect(retried.operations).toContain("revealed");
    expect(runtime.readLifecycleState()).toBe("revealed");
    expect(runtime.readReveal()).toMatchObject({ state: "revealed" });
    expect(runtime.readLiveVisibleSequence()).toBe(
      drafts.at(-1)!.descriptor.endSequence,
    );
    expect(
      store.recovered.events.filter(
        (event) => event.eventType === "premiere_reveal_committed",
      ),
    ).toHaveLength(1);

    readChunkSpy.mockRestore();
  });

  test("projects the current authoritative clock without releasing and rejects read-clock rollback", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    clock.advance(50);
    expect(await runtime.readManifest()).toMatchObject({
      state: "scheduled",
      serverNow: clock.now().toISOString(),
      authoritativeElapsedMs: 0,
    });
    expect(runtime.readChunk(0)).toBeNull();
    clock.advance(-1);
    await expect(runtime.readManifest()).rejects.toThrow(/integrity/i);
  });

  test("repairs a durable reveal after prediction persistence fails and preserves the reveal notification", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const interactions = createInteractions(gate, clock);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions,
    });

    await runtime.synchronize();
    clock.advance(100);
    await runtime.synchronize();
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 100);
    await runtime.synchronize();
    const resolve = vi.spyOn(
      interactions,
      "resolvePredictionsFromAuthoritativeResult",
    );
    resolve.mockRejectedValueOnce(
      new Error("simulated prediction resolution persistence failure"),
    );

    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 50);
    await expect(runtime.synchronize()).rejects.toThrow(
      /simulated prediction resolution persistence failure/,
    );
    expect(runtime.readLifecycleState()).toBe("revealed");
    expect(runtime.readReveal()).toMatchObject({ state: "revealed" });
    expect(
      interactions.readState().checkpoints.map((entry) => entry.resolution),
    ).toEqual([null, null]);

    const repaired = await runtime.synchronize();
    expect(repaired.operations).toEqual(["revealed"]);
    expect(repaired.nextWakeAt).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(
      store.recovered.events.filter(
        (event) => event.eventType === "premiere_reveal_committed",
      ),
    ).toHaveLength(1);
    expect(
      interactions.readState().checkpoints.map((entry) => entry.resolution),
    ).toEqual([
      expect.objectContaining({ kind: "winner", winnerSeatId: "SEAT0001" }),
      expect.objectContaining({ kind: "winner", winnerSeatId: "SEAT0001" }),
    ]);
  });

  test("refuses archive while resolution persistence is unavailable and repairs a legacy archived projection", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const firstStore = await openStore(root);
    stores.push(firstStore);
    const firstInteractions = createInteractions(gate, clock);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: firstStore,
      clock,
      interactions: firstInteractions,
    });

    await runtime.synchronize();
    clock.advance(100);
    await runtime.synchronize();
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 100);
    await runtime.synchronize();
    const resolve = vi
      .spyOn(firstInteractions, "resolvePredictionsFromAuthoritativeResult")
      .mockRejectedValue(
        new Error("simulated persistent prediction persistence failure"),
      );
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 50);
    await expect(runtime.synchronize()).rejects.toThrow(
      /persistent prediction persistence failure/,
    );
    expect(runtime.readLifecycleState()).toBe("revealed");
    const unresolved = firstInteractions.readState();
    expect(
      unresolved.checkpoints.map((checkpoint) => checkpoint.resolution),
    ).toEqual([null, null]);

    await expect(runtime.archive()).rejects.toThrow(
      /persistent prediction persistence failure/,
    );
    expect(runtime.readLifecycleState()).toBe("revealed");
    expect(
      firstStore.recovered.events.filter(
        (event) => event.eventType === "premiere_runtime_archived",
      ),
    ).toHaveLength(0);

    resolve.mockRestore();
    await runtime.archive();
    expect(runtime.readLifecycleState()).toBe("archived");
    expect(firstInteractions.hasCompletePredictionResolution()).toBe(true);
    await closeTrackedStore(firstStore, stores);

    // Simulate a legacy crash image whose runtime archive was durable but whose
    // independently persisted interaction snapshot still lacked resolutions.
    const restartedStore = await openStore(root);
    stores.push(restartedStore);
    const restartedInteractions = createInteractions(gate, clock, unresolved);
    const restarted = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: restartedStore,
      clock,
      interactions: restartedInteractions,
    });
    expect(restarted.readLifecycleState()).toBe("archived");
    expect(restarted.nextWakeAt()).toBe(restarted.readReveal()!.revealedAt);
    await restarted.synchronize();
    expect(restartedInteractions.hasCompletePredictionResolution()).toBe(true);
    expect(restarted.nextWakeAt()).toBeNull();
  });

  test("projects a committed checkpoint deadline immediately while its durable resume remains pending", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const recoverPrefix = vi.spyOn(
      Object.getPrototypeOf(gate),
      "recoverReleasedPrefix",
    );
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    recoverPrefix.mockClear();

    await runtime.synchronize();
    clock.advance(100);
    await runtime.synchronize();
    const eventCountAtOpen = store.recovered.events.length;

    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS - 1);
    expect(await runtime.readManifest()).toMatchObject({
      state: "checkpoint",
      authoritativeElapsedMs: 100,
      accumulatedPauseMs: REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS - 1,
      activeCheckpoint: { state: "open" },
      releasedThroughSequence: 2,
    });

    clock.advance(1);
    expect(runtime.readLifecycleState()).toBe("checkpoint");
    expect(await runtime.readManifest()).toMatchObject({
      state: "playing",
      serverNow: clock.now().toISOString(),
      authoritativeElapsedMs: 100,
      accumulatedPauseMs: REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
      activeCheckpoint: null,
      releasedThroughSequence: 2,
    });
    expect(runtime.readChunk(1)).toBeNull();
    expect(store.recovered.events).toHaveLength(eventCountAtOpen);
    expect((await runtime.readManifest()).state).toBe("playing");
    expect(store.recovered.events).toHaveLength(eventCountAtOpen);

    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("playing");
    expect(runtime.readChunk(1)).toBeNull();
    expect(store.recovered.events).toHaveLength(eventCountAtOpen + 1);
    expect(
      store.recovered.events.filter(
        (event) => event.eventType === "premiere_runtime_checkpoint_resumed",
      ),
    ).toHaveLength(1);
    expect(recoverPrefix).not.toHaveBeenCalled();
  });

  test("linearizes manifest reads behind a durable playing-to-checkpoint transition", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    let armCheckpointWrite = false;
    let checkpointWriteEntered!: () => void;
    let releaseCheckpointWrite!: () => void;
    const checkpointWriteStarted = new Promise<void>((resolve) => {
      checkpointWriteEntered = resolve;
    });
    const checkpointWriteReleased = new Promise<void>((resolve) => {
      releaseCheckpointWrite = resolve;
    });
    const persistence: ReplayPremiereRuntimePersistence = {
      get recovered() {
        return store.recovered;
      },
      readSnapshot: (aggregateId) => store.readSnapshot(aggregateId),
      appendAndSnapshot: async (input) => {
        if (
          armCheckpointWrite &&
          input.event.eventType === "premiere_runtime_chunk_released"
        ) {
          armCheckpointWrite = false;
          checkpointWriteEntered();
          await checkpointWriteReleased;
        }
        return store.appendAndSnapshot(input);
      },
    };
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence,
      clock,
      interactions: createInteractions(gate, clock),
    });

    await runtime.synchronize();
    clock.advance(99);
    const beforeTransition = await runtime.readManifest();
    expect(beforeTransition).toMatchObject({
      state: "playing",
      authoritativeElapsedMs: 99,
      releasedThroughSequence: -1,
    });

    clock.advance(1);
    armCheckpointWrite = true;
    const transition = runtime.synchronize();
    await checkpointWriteStarted;
    clock.advance(25);
    let racedReadSettled = false;
    const racedRead = runtime.readManifest().then((manifest) => {
      racedReadSettled = true;
      return manifest;
    });
    await Promise.resolve();
    const settledBeforeCommit = racedReadSettled;
    releaseCheckpointWrite();

    await transition;
    const atCheckpoint = await racedRead;
    const afterTransition = await runtime.readManifest();
    expect(settledBeforeCommit).toBe(false);
    expect(atCheckpoint).toMatchObject({
      state: "checkpoint",
      serverNow: clock.now().toISOString(),
      authoritativeElapsedMs: 100,
      accumulatedPauseMs: 25,
      releasedThroughSequence: 2,
      activeCheckpoint: { state: "open" },
    });
    expect(afterTransition).toMatchObject({
      state: "checkpoint",
      authoritativeElapsedMs: 100,
      accumulatedPauseMs: 25,
      releasedThroughSequence: 2,
    });
    expect(
      [beforeTransition, atCheckpoint, afterTransition].map((manifest) =>
        "authoritativeElapsedMs" in manifest
          ? manifest.authoritativeElapsedMs
          : null,
      ),
    ).toEqual([99, 100, 100]);
  });

  test("recovers a checkpoint outage with a shifted close and no elapsed double-count", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const firstStore = await openStore(root);
    stores.push(firstStore);
    const firstInteractions = createInteractions(gate, clock);
    const first = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: firstStore,
      clock,
      interactions: firstInteractions,
    });
    await first.synchronize();
    clock.advance(100);
    await first.synchronize();
    clock.advance(5_000);
    await first.beginOutage();
    clock.advance(30_000);
    expect(await first.readManifest()).toMatchObject({
      state: "checkpoint",
      authoritativeElapsedMs: 100,
      accumulatedPauseMs: 35_000,
      releasedThroughSequence: 2,
    });
    expect(first.readChunk(1)).toBeNull();
    await firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const restartedStore = await openStore(root);
    stores.push(restartedStore);
    const restarted = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: restartedStore,
      clock,
      interactions: createInteractions(
        gate,
        clock,
        firstInteractions.readState(),
      ),
    });
    expect(await restarted.readManifest()).toMatchObject({
      state: "checkpoint",
      authoritativeElapsedMs: 100,
      accumulatedPauseMs: 35_000,
      activeCheckpoint: {
        closesAt: new Date(
          NOW.getTime() + 100 + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 30_000,
        ).toISOString(),
      },
    });
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS - 5_000 - 1);
    await restarted.synchronize();
    expect(restarted.readLifecycleState()).toBe("checkpoint");
    expect(restarted.readChunk(1)).toBeNull();
    clock.advance(1);
    await restarted.synchronize();
    expect(await restarted.readManifest()).toMatchObject({
      state: "playing",
      authoritativeElapsedMs: 100,
      accumulatedPauseMs: REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 30_000,
      releasedThroughSequence: 2,
    });
  });

  test.each(["planned_restart", "controlled_outage_drill"] as const)(
    "durably labels and recovers a %s outage without changing the snapshot schema",
    async (reason) => {
      const caseRoot = path.join(root, reason);
      const { gate, drafts } = await verifiedPublicationFixture(caseRoot);
      const clock = new FakeClock(NOW);
      const firstStore = await openStore(caseRoot);
      stores.push(firstStore);
      const interactions = createInteractions(gate, clock);
      const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
        gate,
        drafts,
        persistence: firstStore,
        clock,
        interactions,
      });
      await runtime.synchronize();
      await runtime.beginOutage(reason);

      const started = firstStore.recovered.events.at(-1)!;
      const lifecycleVersion = (
        started.payload as unknown as { lifecycle: { version: number } }
      ).lifecycle.version;
      expect(started.eventType).toBe("premiere_runtime_outage_started");
      expect(started.idempotencyKey).toBe(
        `runtime:outage:${gate.publicationCommitmentHash}:begin:` +
          `${lifecycleVersion}:${reason}`,
      );
      expect(started.payload).not.toHaveProperty("outageReason");
      await firstStore.close();
      stores.splice(stores.indexOf(firstStore), 1);

      clock.advance(1);
      const restartedStore = await openStore(caseRoot);
      stores.push(restartedStore);
      const restarted = await ReplayPremiereRuntimeCoordinator.createOrRecover({
        gate,
        drafts,
        persistence: restartedStore,
        clock,
        interactions: createInteractions(gate, clock, interactions.readState()),
      });
      expect(restarted.readLifecycleState()).toBe("playing");
      expect(restartedStore.recovered.events.at(-1)?.eventType).toBe(
        "premiere_runtime_outage_recovered",
      );
    },
  );

  test("rejects an unrecognized durable outage-reason suffix", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const interactions = createInteractions(gate, clock);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions,
    });
    await runtime.synchronize();
    await runtime.beginOutage("planned_restart");
    const events = structuredClone(store.recovered.events);
    events.at(-1)!.idempotencyKey =
      `${events.at(-1)!.idempotencyKey}:unrecognized`;
    rehashStoredEventChain(events);

    await expect(
      ReplayPremiereRuntimeCoordinator.createOrRecover({
        gate,
        drafts,
        persistence: persistenceForEvents(store.recovered, events),
        clock,
        interactions: createInteractions(gate, clock, interactions.readState()),
      }),
    ).rejects.toMatchObject({
      operatorCode: "premiere_runtime_event_semantics_mismatch",
    });
  });

  test("rejects an unrecognized outage reason before writing", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    await runtime.synchronize();
    const eventCount = store.recovered.events.length;

    await expect(
      runtime.beginOutage("unrecognized" as never),
    ).rejects.toMatchObject({
      operatorCode: "premiere_runtime_invalid_outage_reason",
    });
    expect(store.recovered.events).toHaveLength(eventCount);
  });

  test("delays a prestart outage of any length but fails a playing outage over 60s", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(new Date(NOW.getTime() - 120_000));
    const store = await openStore(root);
    stores.push(store);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    await runtime.beginOutage();
    clock.advance(120_001);
    await runtime.endOutage();
    expect(runtime.readLifecycleState()).toBe("scheduled");
    await expect(runtime.beginOutage()).rejects.toMatchObject({
      operatorCode: "premiere_runtime_outage_transition_limit_exceeded",
    });
    clock.advance(120_000);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("playing");

    clock.advance(50);
    await runtime.beginOutage();
    clock.advance(60_001);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("failed");
    expect(await runtime.readManifest()).toMatchObject({
      state: "failed",
      releasedThroughSequence: -1,
    });
    await runtime.archive();
    expect(runtime.readLifecycleState()).toBe("archived");
    expect(await runtime.readManifest()).toMatchObject({
      state: "failed",
      releasedThroughSequence: -1,
    });
  });

  test("recovers an automatic playing gap and accepts a same-clock restart without a duplicate event", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const firstStore = await openStore(root);
    stores.push(firstStore);
    const interactions = createInteractions(gate, clock);
    const first = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: firstStore,
      clock,
      interactions,
    });
    await first.synchronize();
    await closeTrackedStore(firstStore, stores);

    clock.advance(150);
    const recoveredStore = await openStore(root);
    stores.push(recoveredStore);
    const recovered = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: recoveredStore,
      clock,
      interactions: createInteractions(gate, clock, interactions.readState()),
    });
    expect(recovered.readLifecycleState()).toBe("playing");
    expect(
      recoveredStore.recovered.events.filter(
        (event) => event.eventType === "premiere_runtime_outage_recovered",
      ),
    ).toHaveLength(1);
    const eventCount = recoveredStore.recovered.events.length;
    await closeTrackedStore(recoveredStore, stores);

    const restartedStore = await openStore(root);
    stores.push(restartedStore);
    const restarted = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: restartedStore,
      clock,
      interactions: createInteractions(gate, clock, interactions.readState()),
    });
    expect(restarted.readLifecycleState()).toBe("playing");
    expect(restartedStore.recovered.events).toHaveLength(eventCount);
  });

  test("durably cancels a scheduled premiere and archives it without fabricating a reveal", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const firstStore = await openStore(root);
    stores.push(firstStore);
    const firstInteractions = createInteractions(gate, clock);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: firstStore,
      clock,
      interactions: firstInteractions,
    });

    await runtime.cancel();
    expect(runtime.readLifecycleState()).toBe("cancelled");
    expect(await runtime.readManifest()).toMatchObject({
      state: "cancelled",
      actualStartAt: null,
      releasedThroughSequence: -1,
    });
    await runtime.archive();
    expect(runtime.readLifecycleState()).toBe("archived");
    expect(await runtime.readManifest()).toMatchObject({
      state: "cancelled",
      actualStartAt: null,
      releasedThroughSequence: -1,
    });
    expect(runtime.readReveal()).toBeNull();
    expect(firstStore.recovered.events.map((event) => event.eventType)).toEqual(
      [
        "premiere_runtime_initialized",
        "premiere_runtime_cancelled",
        "premiere_runtime_terminal_archived",
      ],
    );
    await expect(runtime.beginOutage()).rejects.toMatchObject({
      operatorCode: "premiere_runtime_outage_cannot_start_in_current_state",
    });

    await firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);
    const restartedStore = await openStore(root);
    stores.push(restartedStore);
    const restarted = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: restartedStore,
      clock,
      interactions: createInteractions(
        gate,
        clock,
        firstInteractions.readState(),
      ),
    });
    expect(restarted.readLifecycleState()).toBe("archived");
    expect(await restarted.readManifest()).toMatchObject({
      state: "cancelled",
    });
    expect(restarted.readReveal()).toBeNull();
  });

  test("recovers the durable reveal without rollback or duplicate release", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const firstStore = await openStore(root);
    stores.push(firstStore);
    const firstInteractions = createInteractions(gate, clock);
    const first = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: firstStore,
      clock,
      interactions: firstInteractions,
    });
    await first.synchronize();
    clock.advance(100);
    await first.synchronize();
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 100);
    await first.synchronize();
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 49);
    await first.synchronize();
    const unresolvedInteractions = firstInteractions.readState();
    expect(
      unresolvedInteractions.checkpoints.map((entry) => entry.resolution),
    ).toEqual([null, null]);
    clock.advance(1);
    await first.synchronize();
    expect(first.readLifecycleState()).toBe("revealed");
    const eventCount = firstStore.recovered.events.length;
    await firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const restartedStore = await openStore(root);
    stores.push(restartedStore);
    const restartedInteractions = createInteractions(
      gate,
      clock,
      unresolvedInteractions,
    );
    const restarted = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: restartedStore,
      clock,
      interactions: restartedInteractions,
    });
    expect(restarted.readLifecycleState()).toBe("revealed");
    expect(await restarted.readManifest()).toMatchObject({ state: "revealed" });
    expect(restarted.readChunk(2)).toMatchObject({ terminal: true });
    await restarted.synchronize();
    expect(
      restartedInteractions
        .readState()
        .checkpoints.map((entry) => entry.resolution),
    ).toEqual(
      firstInteractions
        .readState()
        .checkpoints.map((entry) => entry.resolution),
    );
    expect(restartedStore.recovered.events).toHaveLength(eventCount);
  });

  test("repairs a stale snapshot after the reveal event is fsynced", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    let failSnapshot = false;
    let armedSnapshotWrites = 0;
    const firstStore = await openStore(root, {
      snapshotWrite: async (handle, buffer, offset, length) => {
        if (failSnapshot && (armedSnapshotWrites += 1) === 2) {
          failSnapshot = false;
          throw new Error("simulated reveal snapshot crash");
        }
        return handle.write(buffer, offset, length, null);
      },
    });
    stores.push(firstStore);
    const interactions = createInteractions(gate, clock);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: firstStore,
      clock,
      interactions,
    });
    await runtime.synchronize();
    clock.advance(100);
    await runtime.synchronize();
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 100);
    await runtime.synchronize();
    failSnapshot = true;
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + 50);
    await expect(runtime.synchronize()).rejects.toThrow(
      /simulated reveal snapshot crash/,
    );
    expect(firstStore.recovered.events.at(-1)?.eventType).toBe(
      "premiere_reveal_committed",
    );
    const eventCount = firstStore.recovered.events.length;
    await closeTrackedStore(firstStore, stores);

    const restartedStore = await openStore(root);
    stores.push(restartedStore);
    const restarted = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: restartedStore,
      clock,
      interactions: createInteractions(gate, clock, interactions.readState()),
    });
    expect(restarted.readLifecycleState()).toBe("revealed");
    expect(restartedStore.recovered.events).toHaveLength(eventCount);
    const repairedSnapshot = await restartedStore.readSnapshot(gate.premiereId);
    expect(repairedSnapshot).toMatchObject({
      lastEventSequence: restartedStore.recovered.events.at(-1)?.eventSequence,
      lastEventHash: restartedStore.recovered.events.at(-1)?.eventHash,
    });
  });

  test.each([
    {
      name: "an unknown lifecycle state",
      mutate: (state: Record<string, any>) => {
        state.lifecycle.state = "bogus";
      },
    },
    {
      name: "terminal semantics on a scheduled lifecycle",
      mutate: (state: Record<string, any>) => {
        state.lifecycle.terminalReasonCode = "runtime_failure";
      },
    },
  ])("rejects hash-valid recovery with $name", async ({ mutate }) => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    const persistence = mutatedRuntimePersistence(store.recovered, mutate);

    await expect(
      ReplayPremiereRuntimeCoordinator.createOrRecover({
        gate,
        drafts,
        persistence,
        clock,
        interactions: createInteractions(gate, clock),
      }),
    ).rejects.toBeDefined();
  });

  test("rejects a hash-valid relabelled initialization event", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    const event = structuredClone(store.recovered.events[0]);
    event.eventType = "premiere_runtime_cancelled";
    rehashStoredEvent(event);
    const persistence = persistenceForEvents(store.recovered, [event]);

    await expect(
      ReplayPremiereRuntimeCoordinator.createOrRecover({
        gate,
        drafts,
        persistence,
        clock,
        interactions: createInteractions(gate, clock),
      }),
    ).rejects.toMatchObject({
      operatorCode: "premiere_runtime_cancel_event_transition_mismatch",
    });
  });

  test("revalidates the full event chain for untrusted custom persistence", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    await store.append({
      aggregateId: "prem_fedcba9876543210",
      eventType: "custom_auxiliary_event",
      occurredAt: new Date(NOW.getTime() + 1).toISOString(),
      payload: { accepted: true },
    });
    const global = store.recovered;
    const validEvents = global.events;
    const events = structuredClone(global.events);
    events[1].eventHash = "f".repeat(64);
    const persistence = persistenceForEvents(global, events);
    const untrustedRecovery = persistence.recovered;
    let eventReads = 0;
    Object.defineProperty(untrustedRecovery, "events", {
      get: () => {
        eventReads += 1;
        return eventReads === 1 ? events : validEvents;
      },
    });

    await expect(
      ReplayPremiereRuntimeCoordinator.createOrRecover({
        gate,
        drafts,
        persistence,
        clock,
        interactions: createInteractions(gate, clock),
      }),
    ).rejects.toMatchObject({
      operatorCode: "premiere_runtime_runtime_event_hash_chain_mismatch",
    });
    expect(eventReads).toBe(1);
  });

  test("consumes one immutable event snapshot when custom persistence mutates its source", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    const sourceEvents = structuredClone(store.recovered.events);
    const base = persistenceForEvents(store.recovered, sourceEvents);
    const persistence: ReplayPremiereRuntimePersistence = {
      ...base,
      readSnapshot: async (aggregateId) => {
        const snapshot = await base.readSnapshot(aggregateId);
        sourceEvents[0].eventType = "premiere_runtime_cancelled";
        sourceEvents[0].payload = { forged: true };
        return snapshot;
      },
    };

    const recovered = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence,
      clock,
      interactions: createInteractions(gate, clock),
    });

    expect(sourceEvents[0]).toMatchObject({
      eventType: "premiere_runtime_cancelled",
      payload: { forged: true },
    });
    expect(recovered.readLifecycleState()).toBe("scheduled");
  });

  test("rejects a hash-valid historical chunk released before its authoritative time", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const interactions = createInteractions(gate, clock);
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions,
    });
    await runtime.synchronize();
    clock.advance(100);
    await runtime.synchronize();
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
    await runtime.synchronize();

    const original = store.recovered;
    const events = structuredClone(original.events);
    const released = events.find(
      (event) => event.eventType === "premiere_runtime_chunk_released",
    );
    expect(released).toBeDefined();
    const releasedState = released!.payload as unknown as {
      actualStartAt: string;
      lastObservedAt: string;
    };
    releasedState.actualStartAt = releasedState.lastObservedAt;
    rehashStoredEventChain(events);
    const latest = events.at(-1)!;
    const snapshot: ReplayPremiereSnapshot = {
      schemaVersion: 1,
      snapshotKind: "replay_premiere_aggregate",
      aggregateId: gate.premiereId,
      lastEventSequence: latest.eventSequence,
      lastEventHash: latest.eventHash,
      state: latest.payload,
      stateHash: hashReplayPremiereJson(latest.payload),
      writtenAt: latest.occurredAt,
    };
    const persistence = readOnlyRuntimePersistence(
      {
        ...original,
        events,
        lastEventSequence: latest.eventSequence,
        lastEventHash: latest.eventHash,
      },
      snapshot,
    );

    await expect(
      ReplayPremiereRuntimeCoordinator.createOrRecover({
        gate,
        drafts,
        persistence,
        clock,
        interactions: createInteractions(gate, clock, interactions.readState()),
      }),
    ).rejects.toMatchObject({
      operatorCode: "premiere_runtime_runtime_released_prefix_mismatch",
    });
  });

  test("rejects a hash-valid scheduled-to-archived recovery jump", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    const initialized = structuredClone(store.recovered.events[0]);
    const occurredAt = new Date(NOW.getTime() + 1_000).toISOString();
    const archivedState = structuredClone(initialized.payload) as unknown as {
      lifecycle: {
        state: string;
        terminalReasonCode: string | null;
        version: number;
        updatedAt: string;
      };
      lastObservedAt: string;
    };
    archivedState.lifecycle.state = "archived";
    archivedState.lifecycle.terminalReasonCode = "cancelled_by_operator";
    archivedState.lifecycle.version += 1;
    archivedState.lifecycle.updatedAt = occurredAt;
    archivedState.lastObservedAt = occurredAt;
    const archived: StoredReplayPremiereEvent = {
      ...initialized,
      eventSequence: initialized.eventSequence + 1,
      eventId: "00000000-0000-4000-8000-000000000001",
      eventType: "premiere_runtime_terminal_archived",
      occurredAt,
      payload: archivedState as unknown as ReplayPremiereJsonValue,
      idempotencyKey: `runtime:archive:${gate.publicationCommitmentHash}`,
      idempotencyStateHash: hashReplayPremiereJson(
        archivedState as unknown as ReplayPremiereJsonValue,
      ),
      previousEventHash: initialized.eventHash,
      eventHash: "",
    };
    rehashStoredEvent(archived);
    const persistence = persistenceForEvents(store.recovered, [
      initialized,
      archived,
    ]);

    await expect(
      ReplayPremiereRuntimeCoordinator.createOrRecover({
        gate,
        drafts,
        persistence,
        clock,
        interactions: createInteractions(gate, clock),
      }),
    ).rejects.toMatchObject({
      operatorCode: "premiere_runtime_archive_event_transition_mismatch",
    });
  });

  test("rejects a self-consistent snapshot that contradicts its anchored event", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });
    const event = store.recovered.events.at(-1)!;
    const contradictory = structuredClone(event.payload) as unknown as Record<
      string,
      any
    >;
    contradictory.scheduleShiftMs = 1;
    const state = contradictory as ReplayPremiereJsonValue;
    const stateHash = hashReplayPremiereJson(state);
    const snapshot: ReplayPremiereSnapshot = {
      schemaVersion: 1,
      snapshotKind: "replay_premiere_aggregate",
      aggregateId: event.aggregateId,
      lastEventSequence: event.eventSequence,
      lastEventHash: event.eventHash,
      state,
      stateHash,
      writtenAt: event.occurredAt,
    };
    const persistence = readOnlyRuntimePersistence(store.recovered, snapshot);

    await expect(
      ReplayPremiereRuntimeCoordinator.createOrRecover({
        gate,
        drafts,
        persistence,
        clock,
        interactions: createInteractions(gate, clock),
      }),
    ).rejects.toMatchObject({
      publicCode: "PREMIERE_INTEGRITY_FAILURE",
    });
  });
});

async function openStore(
  root: string,
  overrides: Partial<
    Pick<Parameters<typeof ReplayPremiereEventStore.open>[0], "snapshotWrite">
  > = {},
): Promise<ReplayPremiereEventStore> {
  const servedRoot = path.join(root, "served");
  await fs.mkdir(servedRoot, { recursive: true });
  return ReplayPremiereEventStore.open({
    privateStateRoot: path.join(root, "private"),
    servedRoots: [servedRoot],
    limits: {
      maxEventBytes: 2_000_000,
      maxAggregateEventBytes: 20_000_000,
      maxEventLogBytes: 30_000_000,
      maxSnapshotBytes: 5_000_000,
      maxPrivateStateBytes: 50_000_000,
    },
    ...overrides,
  });
}

async function closeTrackedStore(
  store: ReplayPremiereEventStore,
  stores: ReplayPremiereEventStore[],
): Promise<void> {
  await store.close();
  stores.splice(stores.indexOf(store), 1);
}

function createInteractions(
  gate: Awaited<ReturnType<typeof verifiedPublicationFixture>>["gate"],
  clock: FakeClock,
  initialState?: ReturnType<ReplayPremiereInteractions["readState"]>,
): ReplayPremiereInteractions {
  const definition = gate.publicDefinition();
  const state: {
    runtime: ProductionReplayPremiereRuntimeCoordinator | null;
  } = { runtime: null };
  const initialPremiereState = initialState?.checkpoints.some(
    (checkpoint) => checkpoint.resolution !== null,
  )
    ? "revealed"
    : "playing";
  const interactions = new ReplayPremiereInteractions({
    premiereId: gate.premiereId,
    checkpointDescriptors: definition.checkpoints,
    seats: definition.provenance.seats,
    getPremiereState: () =>
      state.runtime?.readLifecycleState() ?? initialPremiereState,
    getReleasedContext: () => null,
    getLiveVisibleSequence: () => 0,
    persistence: { persist: async () => undefined },
    signAttribution: () => "a".repeat(64),
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premieres/${gate.premiereId}`,
    now: () => clock.now(),
    admitAnonymousWrite: () => undefined,
    initialState,
  });
  interactionRuntimeState.set(interactions, state);
  return interactions;
}

function allSeatsProjection(
  gate: Awaited<ReturnType<typeof verifiedPublicationFixture>>["gate"],
) {
  const definition = gate.publicDefinition();
  const optionSeatIds = definition.provenance.seats.map((seat) => seat.seatId);
  return freezeReplayPremiereCheckpointProjection({
    premiereId: gate.premiereId,
    publicationCommitmentHash: gate.publicationCommitmentHash,
    checkpoints: [
      { ...definition.checkpoints[0], optionSeatIds },
      { ...definition.checkpoints[1], optionSeatIds },
    ],
  });
}

function mutatedRuntimePersistence(
  recovered: ReplayPremiereEventRecovery,
  mutate: (state: Record<string, any>) => void,
): ReplayPremiereRuntimePersistence {
  const event = structuredClone(
    recovered.events.at(-1)!,
  ) as StoredReplayPremiereEvent;
  const state = structuredClone(event.payload) as unknown as Record<
    string,
    any
  >;
  mutate(state);
  event.payload = state as ReplayPremiereJsonValue;
  event.idempotencyStateHash = hashReplayPremiereJson(event.payload);
  const { eventHash: _discarded, ...preimage } = event;
  event.eventHash = hashReplayPremiereJson(
    preimage as unknown as ReplayPremiereJsonValue,
  );
  const snapshot: ReplayPremiereSnapshot = {
    schemaVersion: 1,
    snapshotKind: "replay_premiere_aggregate",
    aggregateId: event.aggregateId,
    lastEventSequence: event.eventSequence,
    lastEventHash: event.eventHash,
    state: event.payload,
    stateHash: event.idempotencyStateHash,
    writtenAt: event.occurredAt,
  };
  return readOnlyRuntimePersistence(
    {
      ...recovered,
      events: [event],
      lastEventHash: event.eventHash,
    },
    snapshot,
  );
}

function readOnlyRuntimePersistence(
  recovered: ReplayPremiereEventRecovery,
  snapshot: ReplayPremiereSnapshot,
): ReplayPremiereRuntimePersistence {
  return {
    recovered,
    readSnapshot: async () => snapshot,
    appendAndSnapshot: async () => {
      throw new Error("unexpected recovery write");
    },
  };
}

function rehashStoredEvent(event: StoredReplayPremiereEvent): void {
  const { eventHash: _discarded, ...preimage } = event;
  event.eventHash = hashReplayPremiereJson(
    preimage as unknown as ReplayPremiereJsonValue,
  );
}

function rehashStoredEventChain(events: StoredReplayPremiereEvent[]): void {
  let previousEventHash: string | null = null;
  for (const event of events) {
    event.previousEventHash = previousEventHash;
    if (event.idempotencyKey !== null) {
      event.idempotencyStateHash = hashReplayPremiereJson(event.payload);
    }
    rehashStoredEvent(event);
    previousEventHash = event.eventHash;
  }
}

function persistenceForEvents(
  original: ReplayPremiereEventRecovery,
  events: StoredReplayPremiereEvent[],
): ReplayPremiereRuntimePersistence {
  const latest = events.at(-1)!;
  const snapshot: ReplayPremiereSnapshot = {
    schemaVersion: 1,
    snapshotKind: "replay_premiere_aggregate",
    aggregateId: latest.aggregateId,
    lastEventSequence: latest.eventSequence,
    lastEventHash: latest.eventHash,
    state: latest.payload,
    stateHash: hashReplayPremiereJson(latest.payload),
    writtenAt: latest.occurredAt,
  };
  return readOnlyRuntimePersistence(
    {
      ...original,
      events,
      lastEventSequence: latest.eventSequence,
      lastEventHash: latest.eventHash,
    },
    snapshot,
  );
}
