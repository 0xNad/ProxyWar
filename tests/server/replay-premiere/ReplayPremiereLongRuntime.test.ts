import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { freezeReplayPremiereCheckpointProjection } from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import {
  ReplayPremiereEventStore,
  type StoredReplayPremiereEvent,
} from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import {
  canonicalReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { ReplayPremiereInteractions } from "../../../src/server/replay-premiere/ReplayPremiereInteractions";
import { VerifiedPremiereEligibilityGate } from "../../../src/server/replay-premiere/ReplayPremierePublication";
import {
  ReplayPremiereRuntimeCoordinator as ProductionReplayPremiereRuntimeCoordinator,
  type ReplayPremiereRuntimeClock,
} from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import { DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS } from "../../../src/server/replay-premiere/ReplayPremiereStartup";
import {
  LONG_REPLAY_CHECKPOINT_SEQUENCES,
  LONG_REPLAY_CHUNK_LIMITS,
  LONG_REPLAY_TURN_COUNT,
  NOW,
  PREMIERE_ID,
  verifiedLongPublicationFixture,
} from "./ReplayPremiereFixtures";

const ReplayPremiereRuntimeCoordinator = {
  createOrRecover(
    options: Omit<
      Parameters<
        typeof ProductionReplayPremiereRuntimeCoordinator.createOrRecover
      >[0],
      "checkpointProjection"
    >,
  ) {
    const definition = options.gate.publicDefinition();
    const optionSeatIds = definition.provenance.seats.map(
      (seat) => seat.seatId,
    );
    return ProductionReplayPremiereRuntimeCoordinator.createOrRecover({
      ...options,
      checkpointProjection: freezeReplayPremiereCheckpointProjection({
        premiereId: options.gate.premiereId,
        publicationCommitmentHash: options.gate.publicationCommitmentHash,
        checkpoints: [
          { ...definition.checkpoints[0], optionSeatIds },
          { ...definition.checkpoints[1], optionSeatIds },
        ],
      }),
    });
  },
};

class FakeClock implements ReplayPremiereRuntimeClock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

describe("ReplayPremiere long runtime persistence", () => {
  let root: string;
  const stores: ReplayPremiereEventStore[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-long-runtime-"));
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("starts, persists, recovers, reveals, and recovers again above the canonical JSON node ceiling", async () => {
    const { gate, drafts } = await verifiedLongPublicationFixture(root);
    expect(VerifiedPremiereEligibilityGate.isAuthentic(gate)).toBe(true);
    expect(gate.finalSequence + 1).toBe(LONG_REPLAY_TURN_COUNT);
    expect(drafts).toHaveLength(76);
    expect(() =>
      canonicalReplayPremiereJson(drafts as unknown as ReplayPremiereJsonValue),
    ).toThrow(/JSON complexity ceiling exceeded/);

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

    expect(first.readLifecycleState()).toBe("scheduled");
    await first.synchronize();
    expect(first.readLifecycleState()).toBe("playing");
    clock.advance(LONG_REPLAY_CHECKPOINT_SEQUENCES[0]);
    await first.synchronize();
    expect(first.readManifest()).toMatchObject({
      state: "checkpoint",
      releasedThroughSequence: LONG_REPLAY_CHECKPOINT_SEQUENCES[0],
    });
    const firstEventCount = await assertCompactPersistence(firstStore, null);
    const firstInteractionState = firstInteractions.readState();
    await closeTracked(firstStore, stores);

    const secondStore = await openStore(root);
    stores.push(secondStore);
    const secondInteractions = createInteractions(
      gate,
      clock,
      firstInteractionState,
    );
    const second = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: secondStore,
      clock,
      interactions: secondInteractions,
    });
    expect(secondStore.recovered.events).toHaveLength(firstEventCount);
    expect(second.readManifest()).toMatchObject({
      state: "checkpoint",
      releasedThroughSequence: LONG_REPLAY_CHECKPOINT_SEQUENCES[0],
    });
    expect(second.readChunk(0)?.records).toHaveLength(
      LONG_REPLAY_CHUNK_LIMITS.maxRecordsPerChunk,
    );

    clock.advance(15_000);
    await second.synchronize();
    expect(second.readLifecycleState()).toBe("playing");
    clock.advance(
      LONG_REPLAY_CHECKPOINT_SEQUENCES[1] - LONG_REPLAY_CHECKPOINT_SEQUENCES[0],
    );
    await second.synchronize();
    expect(second.readManifest()).toMatchObject({
      state: "checkpoint",
      releasedThroughSequence: LONG_REPLAY_CHECKPOINT_SEQUENCES[1],
    });

    clock.advance(15_000);
    await second.synchronize();
    expect(second.readLifecycleState()).toBe("playing");
    clock.advance(
      LONG_REPLAY_TURN_COUNT - 1 - LONG_REPLAY_CHECKPOINT_SEQUENCES[1],
    );
    const terminalAdvance = await second.synchronize();
    expect(terminalAdvance.operations).toContain("revealed");
    expect(second.readLifecycleState()).toBe("revealed");
    expect(second.readManifest()).toMatchObject({ state: "revealed" });
    expect(second.readChunk(drafts.length - 1)).toMatchObject({
      index: drafts.length - 1,
      terminal: true,
    });
    const revealedEventCount = await assertCompactPersistence(
      secondStore,
      drafts.length - 1,
    );
    const revealedInteractionState = secondInteractions.readState();
    await closeTracked(secondStore, stores);

    const recoveredStore = await openStore(root);
    stores.push(recoveredStore);
    const recovered = await ReplayPremiereRuntimeCoordinator.createOrRecover({
      gate,
      drafts,
      persistence: recoveredStore,
      clock,
      interactions: createInteractions(gate, clock, revealedInteractionState),
    });
    expect(recoveredStore.recovered.events).toHaveLength(revealedEventCount);
    expect(recovered.readLifecycleState()).toBe("revealed");
    expect(recovered.readManifest()).toMatchObject({ state: "revealed" });
    expect(recovered.readChunk(0)?.records).toHaveLength(
      LONG_REPLAY_CHUNK_LIMITS.maxRecordsPerChunk,
    );
    expect(recovered.readChunk(drafts.length - 1)).toMatchObject({
      index: drafts.length - 1,
      terminal: true,
    });
    await recovered.synchronize();
    expect(recoveredStore.recovered.events).toHaveLength(revealedEventCount);
  }, 120_000);
});

async function openStore(root: string): Promise<ReplayPremiereEventStore> {
  const servedRoot = path.join(root, "served");
  await fs.mkdir(servedRoot, { recursive: true });
  return ReplayPremiereEventStore.open({
    privateStateRoot: path.join(root, "private"),
    servedRoots: [servedRoot],
    limits: DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
  });
}

async function closeTracked(
  store: ReplayPremiereEventStore,
  stores: ReplayPremiereEventStore[],
): Promise<void> {
  await store.close();
  stores.splice(stores.indexOf(store), 1);
}

function createInteractions(
  gate: VerifiedPremiereEligibilityGate,
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

async function assertCompactPersistence(
  store: ReplayPremiereEventStore,
  expectedRevealPrefixCount: number | null,
): Promise<number> {
  const events = store.recovered.events;
  const revealEvents = events.filter(
    (event) => event.eventType === "premiere_reveal_committed",
  );
  expect(revealEvents).toHaveLength(expectedRevealPrefixCount === null ? 0 : 1);
  for (const event of events) {
    expectCanonical(event);
    assertCompactEventPayload(event);
  }
  const snapshot = await store.readSnapshot(PREMIERE_ID);
  expect(snapshot).not.toBeNull();
  expectCanonical(snapshot!);
  if (expectedRevealPrefixCount !== null) {
    assertCompactRevealPayload(
      asRecord(snapshot!.state),
      expectedRevealPrefixCount,
    );
  } else {
    assertCompactRuntimePayload(asRecord(snapshot!.state));
  }
  return events.length;
}

function assertCompactEventPayload(event: StoredReplayPremiereEvent): void {
  const payload = asRecord(event.payload);
  if (payload.runtimeKind === "replay_premiere_runtime_v1") {
    assertCompactRuntimePayload(payload);
  }
  if (event.eventType === "premiere_reveal_committed") {
    const prefixCount = payload.releasedPrefixChunkCount;
    if (!Number.isSafeInteger(prefixCount)) {
      throw new Error("expected released prefix count");
    }
    assertCompactRevealPayload(payload, Number(prefixCount));
  }
}

function assertCompactRuntimePayload(
  payload: Record<string, ReplayPremiereJsonValue>,
): void {
  expect(payload.runtimeKind).toBe("replay_premiere_runtime_v1");
  expect(Array.isArray(payload.releasedChunks)).toBe(true);
  for (const descriptor of payload.releasedChunks as ReplayPremiereJsonValue[]) {
    const record = asRecord(descriptor);
    expect(record).not.toHaveProperty("records");
    expect(record).not.toHaveProperty("payload");
  }
  expect(findKeyPaths(payload, "records")).toEqual([]);
}

function assertCompactRevealPayload(
  payload: Record<string, ReplayPremiereJsonValue>,
  expectedPrefixCount: number,
): void {
  expect(payload.commitKind).toBe("terminal_chunk_and_reveal");
  expect(payload).not.toHaveProperty("releasedPrefix");
  expect(payload.releasedPrefixChunkCount).toBe(expectedPrefixCount);
  expect(payload.releasedPrefixLastChunkHash).toMatch(/^[a-f0-9]{64}$/);
  expect(findKeyPaths(payload, "records")).toEqual(["terminalChunk.records"]);
  const terminalChunk = asRecord(payload.terminalChunk);
  const terminalRecords = terminalChunk.records;
  expect(Array.isArray(terminalRecords)).toBe(true);
  expect(
    (terminalRecords as ReplayPremiereJsonValue[]).length,
  ).toBeLessThanOrEqual(LONG_REPLAY_CHUNK_LIMITS.maxRecordsPerChunk);
}

function expectCanonical(value: unknown): void {
  expect(() =>
    canonicalReplayPremiereJson(value as ReplayPremiereJsonValue),
  ).not.toThrow();
}

function asRecord(
  value: ReplayPremiereJsonValue,
): Record<string, ReplayPremiereJsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected JSON object");
  }
  return value;
}

function findKeyPaths(
  value: ReplayPremiereJsonValue,
  searchedKey: string,
  prefix = "",
): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findKeyPaths(entry, searchedKey, `${prefix}[${index}]`),
    );
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    return [
      ...(key === searchedKey ? [path] : []),
      ...findKeyPaths(entry, searchedKey, path),
    ];
  });
}
