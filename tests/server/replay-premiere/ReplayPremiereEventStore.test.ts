import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  readAuthenticReplayPremiereEventRecoveryEvents,
  recoverReplayPremiereEventLog,
  ReplayPremiereEventStore,
  type ReplayPremiereEventStoreLimits,
} from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import { PREMIERE_ID } from "./ReplayPremiereFixtures";

const limits: ReplayPremiereEventStoreLimits = {
  maxEventBytes: 10_000,
  maxAggregateEventBytes: 100_000,
  maxEventLogBytes: 500_000,
  maxSnapshotBytes: 100_000,
  maxPrivateStateBytes: 1_000_000,
};

describe("ReplayPremiereEventStore", () => {
  let root: string;
  let privateRoot: string;
  let servedRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-events-"));
    privateRoot = path.join(root, "private");
    servedRoot = path.join(root, "served");
    await fs.mkdir(servedRoot);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("appends a hash chain, snapshots atomically, and recovers on restart", async () => {
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
      now: () => new Date("2026-07-20T18:00:02.000Z"),
    });
    const first = await store.append({
      aggregateId: PREMIERE_ID,
      eventType: "premiere_published",
      occurredAt: "2026-07-20T18:00:00.000Z",
      payload: { state: "scheduled" },
    });
    const committed = await store.appendAndSnapshot({
      event: {
        aggregateId: PREMIERE_ID,
        eventType: "premiere_started",
        occurredAt: "2026-07-20T18:00:01.000Z",
        payload: { state: "playing" },
      },
      state: { state: "playing", version: 2 },
      idempotencyKey: "premiere-started-v1",
    });

    expect(committed.event.previousEventHash).toBe(first.eventHash);
    expect(committed.snapshot.lastEventHash).toBe(committed.event.eventHash);
    await store.close();

    const reopened = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
    });
    expect(reopened.recovered.events).toHaveLength(2);
    expect(await reopened.readSnapshot(PREMIERE_ID)).toMatchObject({
      state: { state: "playing", version: 2 },
    });
    await reopened.close();
  });

  test("enforces a single writer and fails safely on a partial trailing event", async () => {
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
    });
    await expect(
      ReplayPremiereEventStore.open({
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
        limits,
      }),
    ).rejects.toThrow(/writer_already_active/);
    const eventsPath = store.eventsPath;
    await store.close();
    await fs.appendFile(eventsPath, '{"partial":');

    await expect(
      recoverReplayPremiereEventLog(eventsPath, limits),
    ).rejects.toThrow(/partial_trailing_event_line/);
  });

  test("rejects an on-disk payload whose retained event hash no longer matches", async () => {
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
    });
    await store.append({
      aggregateId: PREMIERE_ID,
      eventType: "premiere_published",
      occurredAt: "2026-07-20T18:00:00.000Z",
      payload: { state: "scheduled" },
    });
    const eventsPath = store.eventsPath;
    await store.close();
    const event = JSON.parse(
      (await fs.readFile(eventsPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    event.payload = { state: "forged" };
    await fs.writeFile(eventsPath, `${JSON.stringify(event)}\n`, {
      mode: 0o600,
    });

    await expect(
      ReplayPremiereEventStore.open({
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
        limits,
      }),
    ).rejects.toThrow(/event_hash_mismatch/);
  });

  test("rejects event and aggregate byte ceilings before writing", async () => {
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits: {
        ...limits,
        maxEventBytes: 256,
        maxAggregateEventBytes: 300,
      },
    });
    await expect(
      store.append({
        aggregateId: PREMIERE_ID,
        eventType: "oversized_event",
        occurredAt: "2026-07-20T18:00:00.000Z",
        payload: { data: "x".repeat(1_000) },
      }),
    ).rejects.toThrow(/event_byte_ceiling_exceeded/);
    expect(store.recovered.events).toHaveLength(0);
    await store.close();
  });

  test("severs payload references and loops short writes before publishing state", async () => {
    let writes = 0;
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
      eventWrite: async (handle, buffer, offset, length) => {
        writes += 1;
        const shortLength = Math.max(1, Math.floor(length / 2));
        return handle.write(buffer, offset, shortLength, null);
      },
    });
    const payload = { nested: { value: "accepted" } };
    const event = await store.append({
      aggregateId: PREMIERE_ID,
      eventType: "premiere_published",
      occurredAt: "2026-07-20T18:00:00.000Z",
      payload,
    });
    payload.nested.value = "mutated";
    expect(writes).toBeGreaterThan(1);
    expect(event.payload).toEqual({ nested: { value: "accepted" } });
    expect(store.recovered.events[0].payload).toEqual({
      nested: { value: "accepted" },
    });
    expect(Object.isFrozen(event.payload)).toBe(true);
    await store.close();
  });

  test("returns caller-owned recovery arrays while reusing immutable stored events", async () => {
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
    });
    await store.append({
      aggregateId: PREMIERE_ID,
      eventType: "premiere_published",
      occurredAt: "2026-07-20T18:00:00.000Z",
      payload: { nested: { value: "accepted" } },
    });

    const first = store.recovered;
    const second = store.recovered;
    expect(
      readAuthenticReplayPremiereEventRecoveryEvents(first),
    ).not.toBeNull();
    expect(
      readAuthenticReplayPremiereEventRecoveryEvents(second),
    ).not.toBeNull();
    expect(first.events).not.toBe(second.events);
    expect(first.events[0]).toBe(second.events[0]);
    expect(Object.isFrozen(first.events[0])).toBe(true);
    expect(Object.isFrozen(first.events[0].payload)).toBe(true);

    first.events.length = 0;
    expect(readAuthenticReplayPremiereEventRecoveryEvents(first)).toBeNull();
    expect(second.events).toHaveLength(1);
    expect(
      readAuthenticReplayPremiereEventRecoveryEvents(second),
    ).not.toBeNull();
    expect(store.recovered.events).toHaveLength(1);
    const nested = (second.events[0].payload as { nested: { value: string } })
      .nested;
    expect(Reflect.set(nested, "value", "mutated")).toBe(false);
    expect(store.recovered.events[0].payload).toEqual({
      nested: { value: "accepted" },
    });

    const getterView = store.recovered;
    const issuedEvents = getterView.events;
    let eventReads = 0;
    Object.defineProperty(getterView, "events", {
      get: () => {
        eventReads += 1;
        return eventReads === 1 ? issuedEvents : [];
      },
    });
    const authenticated =
      readAuthenticReplayPremiereEventRecoveryEvents(getterView);
    expect(eventReads).toBe(1);
    expect(authenticated).not.toBe(issuedEvents);
    expect(authenticated).toEqual(issuedEvents);
    expect(Object.isFrozen(authenticated)).toBe(true);

    const proxied = new Proxy(store.recovered, {});
    expect(readAuthenticReplayPremiereEventRecoveryEvents(proxied)).toBeNull();
    await store.close();
  });

  test("poisons the writer after an ambiguous partial event write", async () => {
    let writes = 0;
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
      eventWrite: async (handle, buffer, offset, length) => {
        writes += 1;
        if (writes > 1) throw new Error("injected event write failure");
        return handle.write(buffer, offset, Math.max(1, length - 1), null);
      },
    });
    await expect(
      store.append({
        aggregateId: PREMIERE_ID,
        eventType: "premiere_published",
        occurredAt: "2026-07-20T18:00:00.000Z",
        payload: { state: "scheduled" },
      }),
    ).rejects.toThrow(/injected event write failure/);
    await expect(
      store.append({
        aggregateId: PREMIERE_ID,
        eventType: "premiere_started",
        occurredAt: "2026-07-20T18:00:01.000Z",
        payload: { state: "playing" },
      }),
    ).rejects.toThrow(/event_store_closed/);
  });

  test("reconciles snapshot failure by idempotency key without duplicate or regression", async () => {
    let failSnapshotSync = true;
    const operation = {
      event: {
        aggregateId: PREMIERE_ID,
        eventType: "premiere_started",
        occurredAt: "2026-07-20T18:00:01.000Z",
        payload: { state: "playing" } as const,
      },
      state: { state: "playing", version: 2 } as const,
      idempotencyKey: "premiere-started-retry-v1",
    };
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
      snapshotSync: async (handle) => {
        if (failSnapshotSync) {
          failSnapshotSync = false;
          throw new Error("injected snapshot sync failure");
        }
        await handle.sync();
      },
    });
    await expect(store.appendAndSnapshot(operation)).rejects.toThrow(
      /injected snapshot sync failure/,
    );
    expect(store.recovered.events).toHaveLength(1);
    expect(
      (await fs.readdir(store.snapshotsDirectory)).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
    await expect(store.appendAndSnapshot(operation)).rejects.toThrow(
      /event_store_closed/,
    );
    await store.close();

    const reopened = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
    });
    const retried = await reopened.appendAndSnapshot(operation);
    expect(reopened.recovered.events).toHaveLength(1);
    expect(retried.snapshot.state).toEqual(operation.state);
    await expect(
      reopened.appendAndSnapshot({
        ...operation,
        state: { state: "scheduled", version: 1 },
      }),
    ).rejects.toThrow(/idempotency_key_payload_mismatch/);
    await reopened.close();
  });

  test("rejects low disk and oversized sparse recovery files before reading", async () => {
    const lowDiskStore = await ReplayPremiereEventStore.open({
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      limits,
      statfs: (async () => ({
        bavail: 1,
        bsize: 1,
      })) as unknown as typeof fs.statfs,
    });
    await expect(
      lowDiskStore.append({
        aggregateId: PREMIERE_ID,
        eventType: "premiere_published",
        occurredAt: "2026-07-20T18:00:00.000Z",
        payload: { state: "scheduled" },
      }),
    ).rejects.toThrow(/free_space_floor/);
    const eventsPath = lowDiskStore.eventsPath;
    await lowDiskStore.close();
    const sparse = await fs.open(eventsPath, "w");
    await sparse.truncate(limits.maxEventLogBytes + 1);
    await sparse.close();
    await expect(
      recoverReplayPremiereEventLog(eventsPath, limits),
    ).rejects.toThrow(/event_log_byte_ceiling/);
  });
});
