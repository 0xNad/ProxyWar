import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
  ReplayPremiereRuntimeCoordinator,
  type ReplayPremiereRuntimeClock,
  type ReplayPremiereRuntimePersistence,
} from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import { NOW, verifiedPublicationFixture } from "./ReplayPremiereFixtures";

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
    const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: store,
      clock,
      interactions: createInteractions(gate, clock),
    });

    expect(runtime.readLifecycleState()).toBe("scheduled");
    expect(runtime.readChunk(0)).toBeNull();
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

async function openStore(root: string): Promise<ReplayPremiereEventStore> {
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
  });
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
