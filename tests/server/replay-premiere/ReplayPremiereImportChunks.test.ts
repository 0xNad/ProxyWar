import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildPremiereChunks,
  isPremiereChunkReleaseDue,
  premiereChunkContentPath,
  verifyPremiereChunkChain,
  verifyPremiereChunkDraftChain,
} from "../../../src/server/replay-premiere/ReplayPremiereChunks";
import { importPremiereReplay } from "../../../src/server/replay-premiere/ReplayPremiereImport";
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
