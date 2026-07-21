import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
import {
  ReplayPremiereRuntimeCoordinator as ProductionReplayPremiereRuntimeCoordinator,
  REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
  type ReplayPremiereRuntimeClock,
  type ReplayPremiereRuntimePersistence,
} from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import { NOW, verifiedPublicationFixture } from "./ReplayPremiereFixtures";

const ReplayPremiereRuntimeCoordinator = {
  createOrRecover(
    options: Omit<
      Parameters<
        typeof ProductionReplayPremiereRuntimeCoordinator.createOrRecover
      >[0],
      "checkpointProjection"
    >,
  ) {
    return ProductionReplayPremiereRuntimeCoordinator.createOrRecover({
      ...options,
      checkpointProjection: allSeatsProjection(options.gate),
    });
  },
};

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
    for (const store of stores.splice(0)) await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("releases only by authoritative time, pauses exactly 15s, and reveals without a viewer read", async () => {
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
    expect(runtime.readManifest()).toMatchObject({
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
    expect(runtime.readManifest()).toMatchObject({
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
    expect(runtime.readChunk(2)).toMatchObject({ terminal: true });
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
    expect(runtime.readManifest()).toMatchObject({
      state: "scheduled",
      serverNow: clock.now().toISOString(),
      authoritativeElapsedMs: 0,
    });
    expect(runtime.readChunk(0)).toBeNull();
    clock.advance(-1);
    expect(() => runtime.readManifest()).toThrow(/integrity/i);
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
    expect(first.readManifest()).toMatchObject({
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
    expect(restarted.readManifest()).toMatchObject({
      state: "checkpoint",
      authoritativeElapsedMs: 100,
      accumulatedPauseMs: 35_000,
      activeCheckpoint: {
        closesAt: new Date(NOW.getTime() + 45_100).toISOString(),
      },
    });
    clock.advance(9_999);
    await restarted.synchronize();
    expect(restarted.readLifecycleState()).toBe("checkpoint");
    expect(restarted.readChunk(1)).toBeNull();
    clock.advance(1);
    await restarted.synchronize();
    expect(restarted.readManifest()).toMatchObject({
      state: "playing",
      authoritativeElapsedMs: 100,
      accumulatedPauseMs: 45_000,
      releasedThroughSequence: 2,
    });
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
    expect(runtime.readManifest()).toMatchObject({
      state: "failed",
      releasedThroughSequence: -1,
    });
    await runtime.archive();
    expect(runtime.readLifecycleState()).toBe("archived");
    expect(runtime.readManifest()).toMatchObject({
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
    expect(runtime.readManifest()).toMatchObject({
      state: "cancelled",
      actualStartAt: null,
      releasedThroughSequence: -1,
    });
    await runtime.archive();
    expect(runtime.readLifecycleState()).toBe("archived");
    expect(runtime.readManifest()).toMatchObject({
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
    expect(restarted.readManifest()).toMatchObject({ state: "cancelled" });
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
    clock.advance(15_100);
    await first.synchronize();
    clock.advance(15_050);
    await first.synchronize();
    expect(first.readLifecycleState()).toBe("revealed");
    const eventCount = firstStore.recovered.events.length;
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
    expect(restarted.readLifecycleState()).toBe("revealed");
    expect(restarted.readManifest()).toMatchObject({ state: "revealed" });
    expect(restarted.readChunk(2)).toMatchObject({ terminal: true });
    await restarted.synchronize();
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
    clock.advance(15_100);
    await runtime.synchronize();
    failSnapshot = true;
    clock.advance(15_050);
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
  return new ReplayPremiereInteractions({
    premiereId: gate.premiereId,
    checkpointDescriptors: definition.checkpoints,
    seats: definition.provenance.seats,
    getPremiereState: () => "playing",
    getReleasedContext: () => null,
    persistence: { persist: async () => undefined },
    signAttribution: () => "a".repeat(64),
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premieres/${gate.premiereId}`,
    now: () => clock.now(),
    admitAnonymousWrite: () => undefined,
    initialState,
  });
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
