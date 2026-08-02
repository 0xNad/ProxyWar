import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AnalyticsAggregateStore, totalEventCount } from "../../../src/server/analytics/AnalyticsAggregateStore";
import { AnalyticsIngestService } from "../../../src/server/analytics/AnalyticsIngestService";
import { AnalyticsRecentRing } from "../../../src/server/analytics/AnalyticsRecentRing";

let artifactsRoot: string;

afterEach(async () => {
  if (artifactsRoot !== undefined) {
    await rm(artifactsRoot, { recursive: true, force: true });
  }
});

function makeService() {
  return {
    aggregateStore: new AnalyticsAggregateStore(artifactsRoot),
    recentRing: new AnalyticsRecentRing(artifactsRoot),
  };
}

function validBatch(visitorId: string) {
  return {
    schemaVersion: 1,
    visitorId,
    events: [{ name: "page_viewed", occurredAt: new Date().toISOString(), route: "/" }],
  };
}

describe("AnalyticsIngestService", () => {
  test("accepts a well-formed batch and persists it to both the aggregate store and the ring", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-ingest-"));
    const { aggregateStore, recentRing } = makeService();
    const service = new AnalyticsIngestService(aggregateStore, recentRing);
    const result = await service.ingest(validBatch("visitor_00000001"));
    expect(result).toEqual({ accepted: 1, droppedInvalid: false, rateLimited: false });
    const file = await aggregateStore.readAll();
    expect(totalEventCount(file, "page_viewed")).toBe(1);
    expect(await recentRing.readAll()).toHaveLength(1);
  });

  test("silently drops a malformed batch instead of throwing", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-ingest-"));
    const { aggregateStore, recentRing } = makeService();
    const service = new AnalyticsIngestService(aggregateStore, recentRing);
    const result = await service.ingest({ garbage: true });
    expect(result).toEqual({ accepted: 0, droppedInvalid: true, rateLimited: false });
  });

  test("drops a batch whose events fail schema validation", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-ingest-"));
    const { aggregateStore, recentRing } = makeService();
    const service = new AnalyticsIngestService(aggregateStore, recentRing);
    const result = await service.ingest({
      schemaVersion: 1,
      visitorId: "visitor_00000002",
      events: [{ name: "not_a_real_event", occurredAt: new Date().toISOString(), route: "/" }],
    });
    expect(result.accepted).toBe(0);
    expect(result.droppedInvalid).toBe(true);
  });

  test("rate-limits a single visitor id submitting past the per-window cap, independent of any other visitor", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-ingest-"));
    const { aggregateStore, recentRing } = makeService();
    const service = new AnalyticsIngestService(aggregateStore, recentRing, {
      visitorLimitPerWindow: 3,
      visitorWindowMs: 60_000,
    });
    const now = new Date("2026-07-31T12:00:00.000Z");
    const spammer = "visitor_spammer_0001";
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.ingest(validBatch(spammer), now)),
    );
    expect(results.filter((result) => result.accepted === 1)).toHaveLength(3);
    expect(results.filter((result) => result.rateLimited)).toHaveLength(2);

    // A different visitor id, same window, is unaffected.
    const otherResult = await service.ingest(validBatch("visitor_other_00001"), now);
    expect(otherResult).toEqual({ accepted: 1, droppedInvalid: false, rateLimited: false });
  });

  test("a rate-limited batch is never written to storage", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-ingest-"));
    const { aggregateStore, recentRing } = makeService();
    const service = new AnalyticsIngestService(aggregateStore, recentRing, {
      visitorLimitPerWindow: 1,
      visitorWindowMs: 60_000,
    });
    const now = new Date("2026-07-31T12:00:00.000Z");
    const visitorId = "visitor_capped_00001";
    await service.ingest(validBatch(visitorId), now);
    await service.ingest(validBatch(visitorId), now);
    const file = await aggregateStore.readAll();
    expect(totalEventCount(file, "page_viewed")).toBe(1);
  });
});
