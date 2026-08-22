import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readReplayPremiereArchivePointer,
  ReplayPremiereArchiveStore,
} from "../../../src/server/replay-premiere/ReplayPremiereArchiveIndex";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  buildPremiereResultSummary,
  type PremiereResultSummaryV1,
} from "../../../src/server/replay-premiere/ReplayPremiereResultSummary";

const SOURCE_SHA = sha256Hex("archive-source-bundle");

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-archive-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function summaryFor(premiereId: string): PremiereResultSummaryV1 {
  return buildPremiereResultSummary({
    premiereId,
    sourceRunId: "controlled-run-001",
    sourceKind: "rated_coworld",
    publicationCommitmentHash: sha256Hex(premiereId),
    terminalState: "revealed",
    revealedAt: "2026-07-20T18:00:00.000Z",
    reclaimedAt: "2026-07-20T18:45:00.000Z",
    outcome: {
      winner: { category: "player", groupLabel: null, seatIds: ["SEAT0001"] },
      turnCount: 6,
      completedAt: "2026-07-20T18:00:00.600Z",
      standings: [
        { seatId: "SEAT0001", displayName: "Alpha", won: true },
        { seatId: "SEAT0002", displayName: "Beta", won: false },
      ],
    },
    predictions: [],
    markers: [{ kind: "betrayal", turn: 3, count: 2 }],
  });
}

describe("ReplayPremiereArchiveStore", () => {
  it("writes the summary before the pointer and resolves it", async () => {
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const summary = summaryFor("prem_indexpersist0001");
    const pointer = await store.recordReclaimed(summary, SOURCE_SHA);

    expect(pointer.premiereId).toBe("prem_indexpersist0001");
    expect(pointer.sourceReplaySha256).toBe(SOURCE_SHA);
    expect(pointer.summaryRelPath).toBe(
      "summaries/prem_indexpersist0001.summary.json",
    );
    expect(store.lookup("prem_indexpersist0001")).toEqual(pointer);
    expect(await store.loadSummary("prem_indexpersist0001")).toEqual(summary);

    // The summary artifact is written durably to disk (read-only).
    const summaryPath = path.join(
      root,
      "archive-v1",
      "summaries",
      "prem_indexpersist0001.summary.json",
    );
    const stat = await fs.stat(summaryPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o400);
  });

  it("survives a restart: a reopened store still resolves the pointer", async () => {
    const first = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const summary = summaryFor("prem_restartresolve01");
    await first.recordReclaimed(summary, SOURCE_SHA);

    // Simulate a server restart by opening a fresh store over the same root.
    const reopened = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    expect(reopened.lookup("prem_restartresolve01")?.summaryHash).toBe(
      summary.summaryHash,
    );
    expect(await reopened.loadSummary("prem_restartresolve01")).toEqual(
      summary,
    );
    expect(reopened.lookup("prem_absent0000000001")).toBeNull();
  });

  it("adopts the durable summary on a pre-pointer-append crash retry", async () => {
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const first = summaryFor("prem_crashretry000001");
    await store.recordReclaimed(first, SOURCE_SHA);

    // Simulate a crash AFTER the summary artifact is durable but BEFORE the
    // pointer append: drop the pointer line, keep the summary on disk.
    const indexPath = path.join(root, "archive-v1", "archive-index.jsonl");
    await fs.writeFile(indexPath, "");
    const reopened = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    expect(reopened.lookup("prem_crashretry000001")).toBeNull();

    // The retry rebuilds a byte-DIFFERENT summary (later reclaimedAt + a marker
    // that arrived after the first build).
    const retry = buildPremiereResultSummary({
      premiereId: "prem_crashretry000001",
      sourceRunId: "controlled-run-001",
      sourceKind: "rated_coworld",
      publicationCommitmentHash: sha256Hex("prem_crashretry000001"),
      terminalState: "revealed",
      revealedAt: "2026-07-20T18:00:00.000Z",
      reclaimedAt: "2026-07-20T19:15:00.000Z",
      outcome: first.outcome,
      predictions: [],
      markers: [
        { kind: "betrayal", turn: 3, count: 2 },
        { kind: "smart", turn: 9, count: 1 },
      ],
    });
    expect(retry.summaryHash).not.toBe(first.summaryHash);

    const pointer = await reopened.recordReclaimed(retry, SOURCE_SHA);
    // The durable first summary is adopted — no archive_summary_is_immutable
    // dead-end, and the pointer + loaded summary converge on the first write.
    expect(pointer.summaryHash).toBe(first.summaryHash);
    expect(
      (await reopened.loadSummary("prem_crashretry000001"))?.summaryHash,
    ).toBe(first.summaryHash);
  });

  it("tolerates a torn trailing line and dedupes duplicate pointers on open", async () => {
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    await store.recordReclaimed(
      summaryFor("prem_dedupe0000000001"),
      SOURCE_SHA,
    );
    // A duplicate append (crash-retry) plus a torn trailing line.
    const indexPath = path.join(root, "archive-v1", "archive-index.jsonl");
    const existing = await fs.readFile(indexPath, "utf8");
    await fs.appendFile(indexPath, `${existing.trim()}\n{"torn":`, "utf8");

    const reopened = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    expect(reopened.reclaimedPremiereIds()).toEqual(["prem_dedupe0000000001"]);
    // Compaction rewrote the index to a single clean line.
    const compacted = await fs.readFile(indexPath, "utf8");
    expect(compacted.trim().split("\n")).toHaveLength(1);
  });

  it("refuses an ambiguous index as read-only terminal proof until normal store recovery compacts it", async () => {
    const premiereId = "prem_exactproof0000001";
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const pointer = await store.recordReclaimed(
      summaryFor(premiereId),
      SOURCE_SHA,
    );
    const indexPath = path.join(root, "archive-v1", "archive-index.jsonl");
    const existing = await fs.readFile(indexPath, "utf8");
    await fs.appendFile(indexPath, `${existing.trim()}\n{"torn":`, "utf8");

    await expect(
      readReplayPremiereArchivePointer({
        privateStateRoot: root,
        premiereId,
      }),
    ).rejects.toMatchObject({ operatorCode: "archive_lookup_index_ambiguous" });

    await ReplayPremiereArchiveStore.open({ privateStateRoot: root });
    await expect(
      readReplayPremiereArchivePointer({
        privateStateRoot: root,
        premiereId,
      }),
    ).resolves.toEqual(pointer);
  });
});
