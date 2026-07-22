import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayPremiereEventStore } from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import { replayPremiereInteractionAggregateId } from "../../../src/server/replay-premiere/ReplayPremiereInteractionRecovery";
import { compactReplayPremiereEventJournal } from "../../../src/server/replay-premiere/ReplayPremiereJournalCompaction";
import { DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS } from "../../../src/server/replay-premiere/ReplayPremiereStartup";

const DROPPED = "prem_compactdropaggr1";
const SURVIVOR = "prem_compactsurvive01";
const LIMITS = DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS;

let root: string;
let served: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-compact-"));
  served = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-served-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(served, { recursive: true, force: true });
});

async function seedJournal(): Promise<void> {
  const store = await ReplayPremiereEventStore.open({
    privateStateRoot: root,
    servedRoots: [served],
    limits: LIMITS,
  });
  await store.appendAndSnapshot({
    event: {
      aggregateId: DROPPED,
      eventType: "e_first",
      occurredAt: "2026-07-20T18:00:00.000Z",
      payload: { n: 1 },
    },
    state: { n: 1 },
    idempotencyKey: "dropped-key-00000001",
  });
  await store.appendAndSnapshot({
    event: {
      aggregateId: SURVIVOR,
      eventType: "e_second",
      occurredAt: "2026-07-20T18:00:01.000Z",
      payload: { n: 2 },
    },
    state: { n: 2 },
    idempotencyKey: "survivor-key-00000001",
  });
  await store.appendAndSnapshot({
    event: {
      aggregateId: DROPPED,
      eventType: "e_third",
      occurredAt: "2026-07-20T18:00:02.000Z",
      payload: { n: 3 },
    },
    state: { n: 3 },
    idempotencyKey: "dropped-key-00000002",
  });
  await store.close();
}

describe("compactReplayPremiereEventJournal", () => {
  it("drops a fully-reclaimed aggregate, re-chains survivors, and survives recovery", async () => {
    await seedJournal();
    const result = await compactReplayPremiereEventJournal({
      privateStateRoot: root,
      reclaimedPremiereIds: [DROPPED],
      presentPremiereIds: [SURVIVOR],
      limits: LIMITS,
    });
    expect(result.compacted).toBe(true);
    expect(result.keptEventCount).toBe(1);
    expect(result.removedEventCount).toBe(2);

    // The rewritten journal recovers cleanly with the survivor re-sequenced.
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: root,
      servedRoots: [served],
      limits: LIMITS,
    });
    const recovered = store.recovered;
    expect(recovered.events).toHaveLength(1);
    expect(recovered.events[0].aggregateId).toBe(SURVIVOR);
    expect(recovered.events[0].eventSequence).toBe(0);
    expect(recovered.events[0].previousEventHash).toBeNull();
    expect(recovered.lastEventSequence).toBe(0);
    // Compaction drops every snapshot so each surviving aggregate re-derives its
    // snapshot from the compacted log during runtime recovery (validated by the
    // event store: a null snapshot is tolerated and repaired). Right after the
    // rewrite the survivor snapshot is intentionally absent.
    expect(await store.readSnapshot(SURVIVOR)).toBeNull();
    await store.close();

    // Every snapshot (dropped and survivor) is gone.
    const snapshots = await fs.readdir(
      path.join(root, "event-store-v1", "snapshots"),
    );
    expect(snapshots.filter((name) => name.endsWith(".snapshot.json"))).toEqual(
      [],
    );
  });

  it("keeps an excluded premiere's events (reclaimed-then-excluded)", async () => {
    await seedJournal();
    const result = await compactReplayPremiereEventJournal({
      privateStateRoot: root,
      reclaimedPremiereIds: [DROPPED],
      presentPremiereIds: [SURVIVOR],
      excludedPremiereIds: [DROPPED], // excluded ⇒ treated as present ⇒ survives
      limits: LIMITS,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("no_reclaimed_aggregates");
    const raw = await fs.readFile(
      path.join(root, "event-store-v1", "events.jsonl"),
      "utf8",
    );
    expect(raw.trim().split("\n")).toHaveLength(3);
  });

  it("does nothing when the reclaimed premiere still has an admission", async () => {
    await seedJournal();
    const result = await compactReplayPremiereEventJournal({
      privateStateRoot: root,
      // DROPPED is in the archive index BUT still admitted (present) — keep it.
      reclaimedPremiereIds: [DROPPED],
      presentPremiereIds: [DROPPED, SURVIVOR],
      limits: LIMITS,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("no_reclaimed_aggregates");
  });

  it("also removes the reclaimed premiere's interaction aggregate", async () => {
    const interactionAgg = replayPremiereInteractionAggregateId(DROPPED);
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: root,
      servedRoots: [served],
      limits: LIMITS,
    });
    await store.appendAndSnapshot({
      event: {
        aggregateId: SURVIVOR,
        eventType: "e_first",
        occurredAt: "2026-07-20T18:00:00.000Z",
        payload: { n: 1 },
      },
      state: { n: 1 },
      idempotencyKey: "survivor-key-00000001",
    });
    await store.appendAndSnapshot({
      event: {
        aggregateId: interactionAgg,
        eventType: "e_interaction",
        occurredAt: "2026-07-20T18:00:01.000Z",
        payload: { n: 2 },
      },
      state: { n: 2 },
      idempotencyKey: "interaction-key-0000001",
    });
    await store.close();

    const result = await compactReplayPremiereEventJournal({
      privateStateRoot: root,
      reclaimedPremiereIds: [DROPPED],
      presentPremiereIds: [SURVIVOR],
      limits: LIMITS,
    });
    expect(result.compacted).toBe(true);
    expect(result.droppedAggregateIds).toContain(interactionAgg);
    expect(result.keptEventCount).toBe(1);
  });

  it("fails closed while a writer holds the lock", async () => {
    await seedJournal();
    // A live lock owned by this process must block compaction.
    const lockPath = path.join(root, "event-store-v1", "write-owner.json");
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, writerId: "x", acquiredAt: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const result = await compactReplayPremiereEventJournal({
      privateStateRoot: root,
      reclaimedPremiereIds: [DROPPED],
      presentPremiereIds: [SURVIVOR],
      limits: LIMITS,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("writer_active");
    // The original journal is untouched (three events remain).
    const raw = await fs.readFile(
      path.join(root, "event-store-v1", "events.jsonl"),
      { encoding: "utf8", flag: constants.O_RDONLY },
    );
    expect(raw.trim().split("\n")).toHaveLength(3);
  });
});
