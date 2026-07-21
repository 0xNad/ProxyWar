import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  ReplayPremiereSnapshot,
  StoredReplayPremiereEvent,
} from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import {
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  recoverCommittedReveal,
  ReplayPremiereAtomicPublication,
  type PremiereRevealPersistence,
} from "../../../src/server/replay-premiere/ReplayPremiereRevealCommit";
import {
  createDraftPremiereLifecycle,
  recordSafeReleasedSequence,
  transitionPremiereLifecycle,
} from "../../../src/server/replay-premiere/ReplayPremiereStateMachine";
import {
  createPremierePublicProvenance,
  toPremierePublicChunkResponse,
  type PremierePreRevealManifestResponse,
} from "../../../src/server/replay-premiere/ReplayPremiereWire";
import {
  NOW,
  PREMIERE_ID,
  verifiedPublicationFixture,
} from "./ReplayPremiereFixtures";

async function prepared(root: string) {
  const { gate, drafts } = await verifiedPublicationFixture(root);
  const first = gate.releaseNonTerminalChunk({
    draft: drafts[0],
    releasedAt: "2026-07-20T18:00:01.000Z",
    previousChunk: null,
    authoritativeElapsedMs: 100,
  });
  const second = gate.releaseNonTerminalChunk({
    draft: drafts[1],
    releasedAt: "2026-07-20T18:00:02.000Z",
    previousChunk: first,
    authoritativeElapsedMs: 200,
  });
  const terminal = gate.prepareTerminalChunk({
    draft: drafts[2],
    releasedAt: "2026-07-20T18:00:03.000Z",
    previousChunk: second,
    authoritativeElapsedMs: 250,
  });
  let lifecycle = createDraftPremiereLifecycle({
    premiereId: PREMIERE_ID,
    createdAt: NOW.toISOString(),
  });
  lifecycle = transitionPremiereLifecycle(lifecycle, {
    action: "publish",
    actor: "operator",
    occurredAt: NOW.toISOString(),
    gate,
  }).snapshot;
  lifecycle = transitionPremiereLifecycle(lifecycle, {
    action: "start",
    actor: "service",
    occurredAt: NOW.toISOString(),
    serviceReady: true,
  }).snapshot;
  for (let sequence = 0; sequence <= 4; sequence += 1) {
    lifecycle = recordSafeReleasedSequence(
      lifecycle,
      sequence,
      NOW.toISOString(),
    );
  }
  const publishedChunks = [first, second].map((chunk) =>
    toPremierePublicChunkResponse(chunk, gate),
  );
  const provenance = createPremierePublicProvenance(gate);
  const manifest: PremierePreRevealManifestResponse = {
    schemaVersion: 1,
    premiereId: PREMIERE_ID,
    state: "playing",
    serverNow: NOW.toISOString(),
    scheduledAt: NOW.toISOString(),
    actualStartAt: NOW.toISOString(),
    playbackRate: 2,
    authoritativeElapsedMs: 250,
    accumulatedPauseMs: 0,
    releasedThroughSequence: 4,
    lastReleasedChunkIndex: 1,
    activeCheckpoint: null,
    provenance,
    releasedChunks: publishedChunks.map((chunk) => ({
      premiereId: chunk.premiereId,
      index: chunk.index,
      startSequence: chunk.startSequence,
      endSequence: chunk.endSequence,
      startTurn: chunk.startTurn,
      endTurn: chunk.endTurn,
      presentationOffsetMs: chunk.presentationOffsetMs,
      previousChunkHash: chunk.previousChunkHash,
      payloadHash: chunk.payloadHash,
      chunkHash: chunk.chunkHash,
      byteLength: chunk.byteLength,
      terminal: false,
      releasedAt: chunk.releasedAt,
    })),
  };
  return { gate, lifecycle, drafts, terminal, publishedChunks, manifest };
}

function durableResult(
  input: Parameters<PremiereRevealPersistence["appendAndSnapshot"]>[0],
): { event: StoredReplayPremiereEvent; snapshot: ReplayPremiereSnapshot } {
  const withoutHash = {
    schemaVersion: 1 as const,
    eventSequence: 0,
    eventId: "00000000-0000-4000-8000-000000000000",
    aggregateId: input.event.aggregateId,
    eventType: input.event.eventType,
    occurredAt: input.event.occurredAt,
    payload: input.event.payload,
    idempotencyKey: input.idempotencyKey ?? null,
    idempotencyStateHash: hashReplayPremiereJson(input.state),
    previousEventHash: null,
  };
  const event: StoredReplayPremiereEvent = {
    ...withoutHash,
    eventHash: hashReplayPremiereJson(
      withoutHash as unknown as ReplayPremiereJsonValue,
    ),
  };
  return {
    event,
    snapshot: {
      schemaVersion: 1,
      snapshotKind: "replay_premiere_aggregate",
      aggregateId: input.event.aggregateId,
      lastEventSequence: 0,
      lastEventHash: event.eventHash,
      state: input.state,
      stateHash: hashReplayPremiereJson(input.state),
      writtenAt: input.event.occurredAt,
    },
  };
}

function rehashEvent(
  event: StoredReplayPremiereEvent,
): StoredReplayPremiereEvent {
  const withStateHash = {
    ...event,
    idempotencyStateHash: hashReplayPremiereJson(event.payload),
  };
  const { eventHash: _discarded, ...withoutHash } = withStateHash;
  return {
    ...withStateHash,
    eventHash: hashReplayPremiereJson(
      withoutHash as unknown as ReplayPremiereJsonValue,
    ),
  };
}

describe("ReplayPremiere state and atomic reveal", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-reveal-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("requires an authentic publication gate and freezes checkpoint release", async () => {
    const { gate } = await verifiedPublicationFixture(root);
    let lifecycle = createDraftPremiereLifecycle({
      premiereId: PREMIERE_ID,
      createdAt: NOW.toISOString(),
    });
    expect(() =>
      transitionPremiereLifecycle(lifecycle, {
        action: "publish",
        actor: "operator",
        occurredAt: NOW.toISOString(),
        gate: Object.create(Object.getPrototypeOf(gate)),
      }),
    ).toThrow(/ineligible|publication/i);
    lifecycle = transitionPremiereLifecycle(lifecycle, {
      action: "publish",
      actor: "operator",
      occurredAt: NOW.toISOString(),
      gate,
    }).snapshot;
    expect(lifecycle.publicationCommitmentHash).toBe(
      gate.publicationCommitmentHash,
    );
    lifecycle = transitionPremiereLifecycle(lifecycle, {
      action: "start",
      actor: "service",
      occurredAt: NOW.toISOString(),
      serviceReady: true,
    }).snapshot;
    lifecycle = transitionPremiereLifecycle(lifecycle, {
      action: "open_checkpoint",
      actor: "service",
      occurredAt: NOW.toISOString(),
    }).snapshot;
    expect(() =>
      recordSafeReleasedSequence(lifecycle, 0, NOW.toISOString()),
    ).toThrow(/release_not_permitted/);
  });

  test("rejects future chunks and manifest/map mismatches at construction", async () => {
    const state = await prepared(root);
    const terminalResponse = toPremierePublicChunkResponse(
      state.terminal.chunk(),
      state.gate,
    );
    expect(
      () =>
        new ReplayPremiereAtomicPublication({
          gate: state.gate,
          lifecycle: state.lifecycle,
          manifest: state.manifest,
          releasedChunks: [...state.publishedChunks, terminalResponse],
        }),
    ).toThrow(/initial_publication|terminal/i);
    expect(
      () =>
        new ReplayPremiereAtomicPublication({
          gate: state.gate,
          lifecycle: state.lifecycle,
          manifest: {
            ...state.manifest,
            releasedChunks: state.manifest.releasedChunks.map((entry, index) =>
              index === 0 ? { ...entry, endSequence: 1 } : entry,
            ),
          },
          releasedChunks: state.publishedChunks,
        }),
    ).toThrow(/manifest_chunk_descriptor_mismatch/);
  });

  test("defensively owns constructor inputs and never exposes terminal before durability", async () => {
    const state = await prepared(root);
    const mutableManifest = JSON.parse(JSON.stringify(state.manifest));
    const mutableChunks = JSON.parse(JSON.stringify(state.publishedChunks));
    const publication = new ReplayPremiereAtomicPublication({
      gate: state.gate,
      lifecycle: state.lifecycle,
      manifest: mutableManifest,
      releasedChunks: mutableChunks,
    });
    mutableManifest.releasedThroughSequence = 999;
    mutableChunks[0].records[0].turn = 999;
    expect(publication.readManifest()).toMatchObject({
      releasedThroughSequence: 4,
    });
    expect(publication.readChunk(0)?.records[0].turn).toBe(0);
    expect(Object.isFrozen(publication.readChunk(0)?.records)).toBe(true);

    let releasePersistence!: (value: ReturnType<typeof durableResult>) => void;
    let captured:
      | Parameters<PremiereRevealPersistence["appendAndSnapshot"]>[0]
      | undefined;
    const persistence: PremiereRevealPersistence = {
      appendAndSnapshot: (input) => {
        captured = input;
        return new Promise((resolve) => {
          releasePersistence = resolve;
        });
      },
    };
    const commit = publication.commitReveal(persistence, {
      lockedLifecycle: state.lifecycle,
      terminal: state.terminal,
    });
    await Promise.resolve();
    expect(captured).toBeDefined();
    expect(publication.readManifest().state).toBe("playing");
    expect(
      publication.readChunk(state.terminal.chunk().descriptor.index),
    ).toBeNull();
    expect(publication.readReveal()).toBeNull();

    releasePersistence(durableResult(captured!));
    const result = await commit;
    expect(captured?.event.payload).toMatchObject({
      releasedPrefixChunkCount: 2,
      releasedPrefixLastChunkHash: state.publishedChunks[1].chunkHash,
    });
    expect(captured?.event.payload).not.toHaveProperty("releasedPrefix");
    expect(publication.readManifest().state).toBe("revealed");
    expect(publication.readChunk(result.terminalChunk.index)?.terminal).toBe(
      true,
    );
    expect(result.reveal.authoritativeResult.bytes.length).toBeGreaterThan(0);
    expect(result.reveal.publicationDraftManifest).toHaveLength(3);
    expect(result.reveal.integrityScope.sourceReplay).toBe(
      "declared_hash_only",
    );
  });

  test("strictly recovers one hash-valid reveal and rejects counterfeit provenance", async () => {
    const state = await prepared(root);
    const publication = new ReplayPremiereAtomicPublication({
      gate: state.gate,
      lifecycle: state.lifecycle,
      manifest: state.manifest,
      releasedChunks: state.publishedChunks,
    });
    let committedEvent: StoredReplayPremiereEvent | undefined;
    const crashAfterAppend: PremiereRevealPersistence = {
      appendAndSnapshot: async (input) => {
        committedEvent = durableResult(input).event;
        throw new Error("simulated snapshot crash");
      },
    };
    await expect(
      publication.commitReveal(crashAfterAppend, {
        lockedLifecycle: state.lifecycle,
        terminal: state.terminal,
      }),
    ).rejects.toThrow(/simulated snapshot crash/);
    const restarted = await verifiedPublicationFixture(root);
    const recovered = recoverCommittedReveal(
      [committedEvent!],
      PREMIERE_ID,
      restarted.gate,
      state.lifecycle,
      state.manifest.releasedChunks,
      restarted.drafts,
    );
    expect(recovered).toMatchObject({
      lifecycle: { state: "revealed" },
      terminalChunk: { terminal: true },
      reveal: { state: "revealed" },
    });

    const corruptions: Array<(payload: Record<string, any>) => void> = [
      (payload) => {
        payload.lifecycle.publicationCommitmentHash = "f".repeat(64);
      },
      (payload) => {
        payload.transitionAuditEvent.lifecycleVersion += 1;
      },
      (payload) => {
        payload.lifecycle.version += 1;
        payload.transitionAuditEvent.lifecycleVersion += 1;
      },
      (payload) => {
        payload.lifecycle.createdAt = "2026-07-20T17:59:59.000Z";
      },
      (payload) => {
        payload.releasedPrefixChunkCount += 1;
      },
      (payload) => {
        payload.releasedPrefixLastChunkHash = "f".repeat(64);
      },
      (payload) => {
        payload.terminalChunk.records[0].turn += 1;
      },
      (payload) => {
        payload.reveal.eligibilityCommitmentNonce = Buffer.alloc(
          32,
          1,
        ).toString("base64url");
      },
      (payload) => {
        payload.reveal.finalSequence += 1;
      },
      (payload) => {
        payload.reveal.revealCommitHash = "e".repeat(64);
      },
      (payload) => {
        payload.reveal.provenance.seats[0].displayName = "Counterfeit";
      },
      (payload) => {
        payload.reveal.authoritativeResult.bytes = Buffer.from(
          "{}",
          "utf8",
        ).toString("base64");
      },
    ];
    for (const mutate of corruptions) {
      const corruptGate = (await verifiedPublicationFixture(root)).gate;
      const corrupt = JSON.parse(
        JSON.stringify(committedEvent),
      ) as StoredReplayPremiereEvent;
      mutate(corrupt.payload as Record<string, any>);
      expect(() =>
        recoverCommittedReveal(
          [rehashEvent(corrupt)],
          PREMIERE_ID,
          corruptGate,
          state.lifecycle,
          state.manifest.releasedChunks,
          state.drafts,
        ),
      ).toThrow();
    }

    const wrongIdempotencyGate = (await verifiedPublicationFixture(root)).gate;
    const wrongIdempotency = JSON.parse(
      JSON.stringify(committedEvent),
    ) as StoredReplayPremiereEvent;
    wrongIdempotency.idempotencyKey = `reveal:${"f".repeat(64)}`;
    expect(() =>
      recoverCommittedReveal(
        [rehashEvent(wrongIdempotency)],
        PREMIERE_ID,
        wrongIdempotencyGate,
        state.lifecycle,
        state.manifest.releasedChunks,
        state.drafts,
      ),
    ).toThrow(/invalid_recovered_reveal_commit/);

    const shiftedTimestampGate = (await verifiedPublicationFixture(root)).gate;
    const shiftedTimestamp = JSON.parse(
      JSON.stringify(committedEvent),
    ) as StoredReplayPremiereEvent;
    const shiftedOccurredAt = "2026-07-20T18:00:03.001Z";
    shiftedTimestamp.occurredAt = shiftedOccurredAt;
    const shiftedPayload = shiftedTimestamp.payload as Record<string, any>;
    shiftedPayload.lifecycle.updatedAt = shiftedOccurredAt;
    shiftedPayload.transitionAuditEvent.occurredAt = shiftedOccurredAt;
    expect(() =>
      recoverCommittedReveal(
        [rehashEvent(shiftedTimestamp)],
        PREMIERE_ID,
        shiftedTimestampGate,
        state.lifecycle,
        state.manifest.releasedChunks,
        state.drafts,
      ),
    ).toThrow(/invalid_recovered_reveal_commit/);
  });
});
