/**
 * A wagering-enabled premiere never pauses the release clock at a
 * checkpoint boundary — the legacy prediction-checkpoint pause
 * (`REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS`, ~60s, twice) existed solely to
 * protect prediction voting from read-ahead; wagering runs no prediction
 * voting on this surface (trading is live and continuous, gated by the
 * authoritative release clock itself — see `ReplayPremiereWageringTypes.ts`),
 * so the pause is doubly moot for it. `/premiere/<id>` (wagering disabled)
 * is completely untouched: same file, same coordinator, only the boolean
 * differs.
 *
 * Checkpoints still exist as content beats: their `optionSeatIds` are still
 * recorded (`ReplayPremiereInteractions.prepareMarkCheckpointPassed`), so
 * post-reveal prediction-resolution eligibility — and therefore the LMSR
 * market's own settlement, which reuses that same resolution path — comes
 * out exactly as correct as the non-wagering case. Only the open window and
 * the pause are gone.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { freezeReplayPremiereCheckpointProjection } from "../../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import { ReplayPremiereEventStore } from "../../../../src/server/replay-premiere/ReplayPremiereEventStore";
import { ReplayPremiereInteractions } from "../../../../src/server/replay-premiere/ReplayPremiereInteractions";
import {
  ReplayPremiereRuntimeCoordinator,
  REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
  type ReplayPremiereRuntimeClock,
} from "../../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import { NOW, verifiedPublicationFixture } from "../ReplayPremiereFixtures";

class FakeClock implements ReplayPremiereRuntimeClock {
  constructor(private value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

const runtimeBox = new WeakMap<
  ReplayPremiereInteractions,
  { runtime: ReplayPremiereRuntimeCoordinator | null }
>();

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
  wageringEnabled: boolean,
): ReplayPremiereInteractions {
  const definition = gate.publicDefinition();
  const box: { runtime: ReplayPremiereRuntimeCoordinator | null } = {
    runtime: null,
  };
  const interactions = new ReplayPremiereInteractions({
    premiereId: gate.premiereId,
    checkpointDescriptors: definition.checkpoints,
    seats: definition.provenance.seats,
    getPremiereState: () => box.runtime?.readLifecycleState() ?? "playing",
    getReleasedContext: () => null,
    getLiveVisibleSequence: () => 0,
    persistence: { persist: async () => undefined },
    signAttribution: () => "a".repeat(64),
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premieres/${gate.premiereId}`,
    now: () => clock.now(),
    admitAnonymousWrite: () => undefined,
    wageringEnabled,
  });
  runtimeBox.set(interactions, box);
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

async function createRuntime(
  gate: Awaited<ReturnType<typeof verifiedPublicationFixture>>["gate"],
  drafts: Awaited<ReturnType<typeof verifiedPublicationFixture>>["drafts"],
  store: ReplayPremiereEventStore,
  clock: FakeClock,
  interactions: ReplayPremiereInteractions,
): Promise<ReplayPremiereRuntimeCoordinator> {
  const runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
    gate,
    drafts,
    checkpointProjection: allSeatsProjection(gate),
    persistence: store,
    clock,
    interactions,
  });
  const box = runtimeBox.get(interactions);
  if (box !== undefined) box.runtime = runtime;
  return runtime;
}

describe("checkpoint-pause bypass for wagering-enabled premieres", () => {
  let root: string;
  const stores: ReplayPremiereEventStore[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-cp-bypass-"));
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a wagering-enabled premiere runs start to finish with no release pause, ever", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const interactions = createInteractions(gate, clock, true);
    const runtime = await createRuntime(gate, drafts, store, clock, interactions);

    const observedStates: string[] = [];
    await runtime.synchronize();
    observedStates.push(runtime.readLifecycleState());

    // Walk the whole premiere to reveal in small increments — far short of
    // a single REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS (60s) — proving no
    // checkpoint pause is ever inserted anywhere along the way. The
    // non-wagering control below needs 2 full 60s pauses to reach the same
    // point; this reaches it without a single one.
    for (let i = 0; i < 40 && runtime.readLifecycleState() !== "revealed"; i++) {
      clock.advance(50);
      await runtime.synchronize();
      observedStates.push(runtime.readLifecycleState());
      // The core assertion: the release clock never halts for a
      // checkpoint on a wagering premiere.
      expect(runtime.readLifecycleState()).not.toBe("checkpoint");
      expect(runtime.readActiveCheckpoint()).toBeNull();
    }

    expect(runtime.readLifecycleState()).toBe("revealed");
    expect(observedStates).not.toContain("checkpoint");

    // Checkpoints still exist as content beats: both were marked passed
    // (closed) with real optionSeatIds recorded, never left "upcoming".
    const finalCheckpoints = interactions.readState().checkpoints;
    expect(finalCheckpoints).toHaveLength(2);
    for (const checkpoint of finalCheckpoints) {
      expect(checkpoint.state).toBe("closed");
      expect(checkpoint.optionSeatIds).toEqual(["SEAT0001", "SEAT0002"]);
      // opensAt === closesAt: a zero-duration "passed" marker, not a real
      // window a participant could have voted or staked within.
      expect(checkpoint.opensAt).toBe(checkpoint.closesAt);
    }

    // Prediction/market resolution — which depends on every checkpoint's
    // optionSeatIds to derive winner eligibility — came out correct, not
    // silently voided by an empty-options bug.
    for (const checkpoint of finalCheckpoints) {
      expect(checkpoint.resolution).toMatchObject({
        kind: "winner",
        winnerSeatId: "SEAT0001",
      });
    }
    expect(interactions.readState().market).toMatchObject({
      status: "settled",
      winnerSeatId: "SEAT0001",
    });
  });

  test("a non-wagering premiere still pauses at both checkpoints exactly as today", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    const clock = new FakeClock(NOW);
    const store = await openStore(root);
    stores.push(store);
    const interactions = createInteractions(gate, clock, false);
    const runtime = await createRuntime(gate, drafts, store, clock, interactions);

    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("playing");

    clock.advance(99);
    await runtime.synchronize();
    clock.advance(1);
    const firstBoundary = await runtime.synchronize();
    expect(firstBoundary.operations).toEqual([
      "chunk_released",
      "checkpoint_opened",
    ]);
    // The pause is real: the release clock will not move again until it
    // elapses, however long we wait short of it.
    expect(runtime.readLifecycleState()).toBe("checkpoint");
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS - 1);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("checkpoint");
    const checkpoint = runtime.readActiveCheckpoint();
    expect(checkpoint).not.toBeNull();
    expect(
      Date.parse(checkpoint!.closesAt) - Date.parse(checkpoint!.opensAt),
    ).toBe(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);

    clock.advance(1);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("playing");

    clock.advance(100);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("checkpoint");
    clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
    await runtime.synchronize();
    expect(runtime.readLifecycleState()).toBe("playing");

    clock.advance(60);
    const terminal = await runtime.synchronize();
    expect(terminal.operations).toContain("revealed");
    expect(runtime.readLifecycleState()).toBe("revealed");
    expect(
      interactions.readState().checkpoints.map((entry) => entry.resolution),
    ).toEqual([
      expect.objectContaining({ kind: "winner", winnerSeatId: "SEAT0001" }),
      expect.objectContaining({ kind: "winner", winnerSeatId: "SEAT0001" }),
    ]);
  });
});
