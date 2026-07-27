import { describe, expect, it, vi } from "vitest";
import {
  ReplayPremiereFinalizationSignal,
  ReplayPremierePlaybackController,
  ReplayPremiereProtocolError,
  VerifiedReplayPremiereBatch,
} from "../../src/client/ReplayPremierePlayback";
import { Turn } from "../../src/core/Schemas";

const HASH_0 = "0".repeat(64);
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);

function turn(turnNumber: number, hash?: number): Turn {
  return { turnNumber, intents: [], hash };
}

function batch(
  overrides: Partial<VerifiedReplayPremiereBatch> = {},
): VerifiedReplayPremiereBatch {
  return {
    premiereId: "prem_0123456789abcdef",
    chunkIndex: 0,
    chunkHash: HASH_1,
    previousChunkHash: null,
    payloadHash: HASH_0,
    startSequence: 0,
    endSequence: 1,
    verification: {
      payloadHashVerified: true,
      chunkHashVerified: true,
    },
    records: [
      { sequence: 0, presentationOffsetMs: 0, turn: turn(0, 100) },
      { sequence: 1, presentationOffsetMs: 100, turn: turn(1) },
    ],
    ...overrides,
  };
}

function finalization(
  overrides: Partial<ReplayPremiereFinalizationSignal> = {},
): ReplayPremiereFinalizationSignal {
  return {
    premiereId: "prem_0123456789abcdef",
    finalSequence: 1,
    finalChunkHash: HASH_1,
    revealedAt: 1_000,
    verification: {
      contentChainVerified: "storage_chunk_hash_chain",
      publicationCommitmentVerified: true,
      provenanceVerified: true,
      eligibilityCommitmentVerified: true,
      sourceReplayIntegrityScope: "declared_hash_only",
      sourceReplayCommitmentMatched: true,
      authoritativeResultBytesVerified: true,
      resultCommitmentMatched: true,
      revealCommitmentVerified: true,
    },
    ...overrides,
  };
}

function expectProtocolError(
  operation: () => unknown,
  code: ReplayPremiereProtocolError["code"],
) {
  try {
    operation();
    throw new Error("expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayPremiereProtocolError);
    expect((error as ReplayPremiereProtocolError).code).toBe(code);
  }
}

describe("ReplayPremierePlaybackController", () => {
  it("requires canonical Premiere ids and lowercase digest encoding", () => {
    expectProtocolError(
      () => new ReplayPremierePlaybackController("premiere-1"),
      "invalid_configuration",
    );
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    expectProtocolError(
      () =>
        controller.appendVerifiedBatch(batch({ chunkHash: "A".repeat(64) })),
      "invalid_hash",
    );
  });

  it("accepts ordered verified batches and treats an exact retry as idempotent", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const listener = vi.fn();
    controller.subscribe(listener);

    expect(controller.appendVerifiedBatch(batch()).status).toBe("appended");
    expect(controller.appendVerifiedBatch(batch()).status).toBe("duplicate");

    const second = batch({
      chunkIndex: 1,
      chunkHash: HASH_2,
      previousChunkHash: HASH_1,
      payloadHash: HASH_3,
      startSequence: 2,
      endSequence: 2,
      records: [{ sequence: 2, presentationOffsetMs: 200, turn: turn(2, 300) }],
    });
    expect(controller.appendVerifiedBatch(second).status).toBe("appended");
    expect(controller.state()).toMatchObject({
      nextChunkIndex: 2,
      nextExpectedSequence: 3,
      nextExpectedTurnNumber: 3,
      releasedThroughSequence: 2,
      lastChunkHash: HASH_2,
    });
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      "batch",
      "batch",
    ]);
  });

  it("rejects chunk, sequence, turn, and conflicting-duplicate gaps", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    controller.appendVerifiedBatch(batch());

    expectProtocolError(
      () =>
        controller.appendVerifiedBatch(
          batch({
            chunkIndex: 2,
            chunkHash: HASH_2,
            previousChunkHash: HASH_1,
            startSequence: 2,
            endSequence: 2,
            records: [
              { sequence: 2, presentationOffsetMs: 200, turn: turn(2) },
            ],
          }),
        ),
      "chunk_gap",
    );
    expectProtocolError(
      () =>
        controller.appendVerifiedBatch(
          batch({
            chunkIndex: 1,
            chunkHash: HASH_2,
            previousChunkHash: HASH_1,
            startSequence: 3,
            endSequence: 3,
            records: [
              { sequence: 3, presentationOffsetMs: 300, turn: turn(2) },
            ],
          }),
        ),
      "sequence_gap",
    );
    expectProtocolError(
      () =>
        controller.appendVerifiedBatch(
          batch({
            chunkIndex: 1,
            chunkHash: HASH_2,
            previousChunkHash: HASH_1,
            startSequence: 2,
            endSequence: 2,
            records: [
              { sequence: 2, presentationOffsetMs: 200, turn: turn(3) },
            ],
          }),
        ),
      "turn_gap",
    );
    expectProtocolError(
      () =>
        controller.appendVerifiedBatch(
          batch({ chunkHash: HASH_3, payloadHash: HASH_2 }),
        ),
      "conflicting_duplicate",
    );
  });

  it("does not admit unverified, arbitrary, or outcome-bearing JSON records", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );

    expectProtocolError(
      () =>
        controller.appendVerifiedBatch(
          batch({
            verification: {
              payloadHashVerified: false,
              chunkHashVerified: true,
            } as never,
          }),
        ),
      "unverified_batch",
    );
    expectProtocolError(
      () =>
        controller.appendVerifiedBatch(
          batch({
            endSequence: 0,
            records: [
              {
                sequence: 0,
                turn: {
                  turnNumber: 0,
                  payload: { winner: ["player", "secret-seat"] },
                },
              } as never,
            ],
          }),
        ),
      "invalid_batch",
    );
    expectProtocolError(
      () =>
        controller.appendVerifiedBatch(
          batch({
            endSequence: 0,
            records: [
              {
                sequence: 0,
                turn: {
                  turnNumber: 0,
                  intents: [],
                  winner: ["player", "secret-seat"],
                },
              } as never,
            ],
          }),
        ),
      "invalid_batch",
    );
    expect(controller.state().releasedThroughSequence).toBeNull();
  });

  it("permits forward catch-up only through the released boundary", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.appendVerifiedBatch(batch());

    controller.requestForwardCatchUp(1);
    expect(listener).toHaveBeenLastCalledWith({
      type: "catch-up",
      targetSequence: 1,
    });
    expectProtocolError(
      () => controller.requestForwardCatchUp(2),
      "future_seek",
    );

    controller.acknowledgeDispatchedRecord({
      sequence: 0,
      presentationOffsetMs: 0,
      turn: turn(0),
    });
    controller.acknowledgeDispatchedRecord({
      sequence: 1,
      presentationOffsetMs: 100,
      turn: turn(1),
    });
    expectProtocolError(
      () => controller.requestForwardCatchUp(0),
      "backward_seek",
    );
  });

  it("finalizes only after explicit result/source/release integrity checks", () => {
    const controller = new ReplayPremierePlaybackController(
      "prem_0123456789abcdef",
    );
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.appendVerifiedBatch(batch());

    expectProtocolError(
      () =>
        controller.finalize(
          finalization({
            verification: {
              contentChainVerified: "storage_chunk_hash_chain",
              publicationCommitmentVerified: true,
              provenanceVerified: true,
              eligibilityCommitmentVerified: true,
              sourceReplayIntegrityScope: "declared_hash_only",
              sourceReplayCommitmentMatched: true,
              authoritativeResultBytesVerified: true,
              resultCommitmentMatched: false,
              revealCommitmentVerified: true,
            } as never,
          }),
        ),
      "invalid_finalization",
    );
    expectProtocolError(
      () => controller.finalize(finalization({ finalSequence: 2 })),
      "invalid_finalization",
    );

    controller.finalize(finalization());
    expect(controller.state().finalized).toBe(true);
    expect(listener.mock.calls.at(-1)?.[0].type).toBe("finalized");
    expectProtocolError(
      () =>
        controller.appendVerifiedBatch(
          batch({
            chunkIndex: 1,
            chunkHash: HASH_2,
            previousChunkHash: HASH_1,
            startSequence: 2,
            endSequence: 2,
            records: [
              { sequence: 2, presentationOffsetMs: 200, turn: turn(2) },
            ],
          }),
        ),
      "already_finalized",
    );
  });
});
