import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayPremiereArchiveStore } from "../../../src/server/replay-premiere/ReplayPremiereArchiveIndex";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  buildPremiereResultSummary,
  type PremiereResultSummaryV1,
} from "../../../src/server/replay-premiere/ReplayPremiereResultSummary";

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
    const pointer = await store.recordReclaimed(summary);

    expect(pointer.premiereId).toBe("prem_indexpersist0001");
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
    await first.recordReclaimed(summary);

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

  it("tolerates a torn trailing line and dedupes duplicate pointers on open", async () => {
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    await store.recordReclaimed(summaryFor("prem_dedupe0000000001"));
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
});
