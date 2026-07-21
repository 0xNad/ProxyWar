import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildPremiereChunks,
  isPremiereChunkReleaseDue,
  premiereChunkContentPath,
  REPLAY_PREMIERE_MAX_CHUNK_COUNT,
  verifyPremiereChunkChain,
  verifyPremiereChunkDraftChain,
} from "../../../src/server/replay-premiere/ReplayPremiereChunks";
import { importPremiereReplay } from "../../../src/server/replay-premiere/ReplayPremiereImport";
import { canonicalReplayPremiereJson } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  createPremierePublicBootstrap,
  toPremierePublicChunkResponse,
} from "../../../src/server/replay-premiere/ReplayPremiereWire";
import {
  gameStartInfo,
  IMPORT_LIMITS,
  PREMIERE_ID,
  verifiedPublicationFixture,
} from "./ReplayPremiereFixtures";

function imported() {
  return importPremiereReplay(
    {
      gameStartInfo: gameStartInfo(),
      turnCount: 6,
      turnIntervalMs: 100,
      turns: [
        { turn: { turnNumber: 0, intents: [] } },
        { turn: { turnNumber: 2, intents: [], hash: 123 } },
        { turn: { turnNumber: 5, intents: [] } },
      ],
    },
    IMPORT_LIMITS,
  );
}

describe("ReplayPremiere import and chunks", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-import-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("anchors bootstrap and safe definition to the frozen publication commitment", async () => {
    const { gate } = await verifiedPublicationFixture(root);
    const bootstrap = createPremierePublicBootstrap({ gate });

    expect(bootstrap.provenance).toMatchObject({
      sourceRunId: gate.sourceRunId,
      sourceReplaySha256: gate.sourceReplaySha256,
      eligibilityRecordHash: gate.eligibilityRecordHash,
      publicationCommitmentHash: gate.publicationCommitmentHash,
    });
    expect(bootstrap).not.toHaveProperty("publicationCommitment");
    expect(bootstrap).not.toHaveProperty("finalSequence");
    expect(bootstrap).not.toHaveProperty("chunkCount");
    expect(bootstrap.integrityScope.publicationCommitment).toBe(
      "anchored_server_enforced",
    );
    expect(bootstrap.publicDefinition).not.toHaveProperty("winner");
    expect(bootstrap.integrityScope.sourceReplay).toBe("declared_hash_only");
  });

  test("strictly validates core records and expands sparse turns to dense sequences", () => {
    const replay = imported();

    expect(replay.records.map((record) => record.sequence)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(replay.records.map((record) => record.turn)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(replay.records.map((record) => record.nominalOffsetMs)).toEqual([
      0, 100, 200, 300, 400, 500,
    ]);
    expect(replay.records[1].payload).toEqual({ turnNumber: 1, intents: [] });
  });

  test("rejects outcome fields, unknown bootstrap fields, and turn disorder", () => {
    expect(() =>
      importPremiereReplay(
        {
          gameStartInfo: { ...gameStartInfo(), harmlessUnknown: true },
          turnCount: 4,
          turnIntervalMs: 100,
          turns: [],
        },
        IMPORT_LIMITS,
      ),
    ).toThrow(/invalid_game_start_info/);
    expect(() =>
      importPremiereReplay(
        {
          gameStartInfo: { ...gameStartInfo(), winner: "SEAT0001" },
          turnCount: 4,
          turnIntervalMs: 100,
          turns: [],
        },
        IMPORT_LIMITS,
      ),
    ).toThrow(/outcome-bearing/i);
    expect(() =>
      importPremiereReplay(
        {
          gameStartInfo: gameStartInfo(),
          turnCount: 4,
          turnIntervalMs: 100,
          turns: [
            { turn: { turnNumber: 2, intents: [] } },
            { turn: { turnNumber: 2, intents: [] } },
          ],
        },
        IMPORT_LIMITS,
      ),
    ).toThrow(/duplicate_or_out_of_order_turn/);
  });

  test("builds deterministic chains with exact checkpoints, terminal, and span bound", () => {
    const options = {
      premiereId: PREMIERE_ID,
      records: imported().records,
      playbackRate: 2 as const,
      checkpointSequences: [2, 4],
      maxChunkBytes: 100_000,
      maxTotalBytes: 1_000_000,
      maxRecordsPerChunk: 20,
      maxPresentationSpanMs: 100,
    };
    const first = buildPremiereChunks(options);
    const second = buildPremiereChunks(options);

    expect(first.map((chunk) => chunk.descriptor.endSequence)).toEqual([
      2, 4, 5,
    ]);
    expect(first.map((chunk) => chunk.descriptor.terminal)).toEqual([
      false,
      false,
      true,
    ]);
    expect(first.map((chunk) => chunk.descriptor.prepublicationHash)).toEqual(
      second.map((chunk) => chunk.descriptor.prepublicationHash),
    );
    for (const chunk of first) {
      const records = chunk.payload.records;
      expect(
        records.at(-1)!.presentationOffsetMs - records[0].presentationOffsetMs,
      ).toBeLessThanOrEqual(100);
    }
    expect(() =>
      buildPremiereChunks({ ...options, maxPresentationSpanMs: 1_001 }),
    ).toThrow(/hard_maximum/);
  });

  test("preserves exact canonical byte boundaries for multibyte records", () => {
    const records = Array.from({ length: 6 }, (_, sequence) => ({
      sequence,
      turn: sequence,
      nominalOffsetMs: sequence,
      payload: {
        turnNumber: sequence,
        intents: [],
        hash: `${sequence}-界界`,
      },
    }));
    const firstTwoPayload = {
      schemaVersion: 1,
      records: records.slice(0, 2).map((record) => ({
        sequence: record.sequence,
        turn: record.turn,
        presentationOffsetMs: record.nominalOffsetMs,
        payload: record.payload,
      })),
    };
    const exactFirstTwoBytes = Buffer.byteLength(
      canonicalReplayPremiereJson(firstTwoPayload),
      "utf8",
    );

    const chunks = buildPremiereChunks({
      premiereId: PREMIERE_ID,
      records,
      playbackRate: 1,
      checkpointSequences: [2, 4],
      maxChunkBytes: exactFirstTwoBytes,
      maxTotalBytes: 1_000_000,
      maxRecordsPerChunk: 20,
      maxPresentationSpanMs: 1_000,
    });

    expect(chunks.map((chunk) => chunk.descriptor.endSequence)).toEqual([
      1, 2, 4, 5,
    ]);
    expect(chunks[0].descriptor.byteLength).toBe(exactFirstTwoBytes);
    verifyPremiereChunkDraftChain(chunks, [2, 4]);
  });

  test("builds a 57,000-turn dense source class comfortably inside the startup fence", () => {
    const records = Array.from({ length: 57_000 }, (_, sequence) => ({
      sequence,
      turn: sequence,
      nominalOffsetMs: sequence,
      payload: { turnNumber: sequence, intents: [] },
    }));
    const startedAt = performance.now();
    const chunks = buildPremiereChunks({
      premiereId: PREMIERE_ID,
      records,
      playbackRate: 1,
      checkpointSequences: [19_950, 37_050],
      maxChunkBytes: 1_048_576,
      maxTotalBytes: 128 * 1_048_576,
      maxRecordsPerChunk: 1_000,
      maxPresentationSpanMs: 1_000,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(chunks).toHaveLength(58);
    expect(
      chunks.some((chunk) => chunk.descriptor.endSequence === 19_950),
    ).toBe(true);
    expect(
      chunks.some((chunk) => chunk.descriptor.endSequence === 37_050),
    ).toBe(true);
    expect(chunks.at(-1)?.descriptor.endSequence).toBe(56_999);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 10_000);

  test("rejects a draft manifest above the bounded chunk-count ceiling", () => {
    const records = Array.from(
      { length: REPLAY_PREMIERE_MAX_CHUNK_COUNT + 1 },
      (_, sequence) => ({
        sequence,
        turn: sequence,
        nominalOffsetMs: sequence,
        payload: { turnNumber: sequence, intents: [] },
      }),
    );

    expect(() =>
      buildPremiereChunks({
        premiereId: PREMIERE_ID,
        records,
        playbackRate: 1,
        checkpointSequences: [1, 2],
        maxChunkBytes: 1_000_000,
        maxTotalBytes: 128_000_000,
        maxRecordsPerChunk: 1,
        maxPresentationSpanMs: 1_000,
      }),
    ).toThrow(/chunk_count_ceiling_exceeded/);
  });

  test("releases only after chunk end and severs mutable caller references", async () => {
    const { gate, drafts } = await verifiedPublicationFixture(root);
    expect(isPremiereChunkReleaseDue(drafts[0], 99)).toBe(false);
    expect(() =>
      gate.releaseNonTerminalChunk({
        draft: drafts[0],
        releasedAt: "2026-07-20T18:00:01.000Z",
        previousChunk: null,
        authoritativeElapsedMs: 99,
      }),
    ).toThrow(/before_presentation_end/);

    const callerDraft = JSON.parse(JSON.stringify(drafts[0]));
    const released = gate.releaseNonTerminalChunk({
      draft: callerDraft,
      releasedAt: "2026-07-20T18:00:01.000Z",
      previousChunk: null,
      authoritativeElapsedMs: 100,
    });
    callerDraft.payload.records[0].turn = 999;
    expect(released.payload.records[0].turn).toBe(0);
    expect(Object.isFrozen(released.payload.records[0])).toBe(true);
    verifyPremiereChunkChain([released], [], { allowPartialChain: true });
    expect(premiereChunkContentPath(released.descriptor.chunkHash)).toMatch(
      /^chunks\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/,
    );
    const response = toPremierePublicChunkResponse(released, gate);
    expect(Object.isFrozen(response.records)).toBe(true);
  });

  test("detects a copied draft payload mutation", async () => {
    const { drafts } = await verifiedPublicationFixture(root);
    const tampered = JSON.parse(JSON.stringify(drafts));
    tampered[1].payload.records[0].turn = 999;
    expect(() => verifyPremiereChunkDraftChain(tampered, [2, 4])).toThrow(
      /payload_hash_mismatch/,
    );
  });
});
