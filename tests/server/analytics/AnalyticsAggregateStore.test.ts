import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  AnalyticsAggregateStore,
  mergedDimensionCounts,
  mergedRouteCounts,
  totalEventCount,
  trailingEventCount,
} from "../../../src/server/analytics/AnalyticsAggregateStore";
import type { AnalyticsEvent } from "../../../src/server/analytics/AnalyticsEventSchema";

let artifactsRoot: string;

afterEach(async () => {
  if (artifactsRoot !== undefined) {
    await rm(artifactsRoot, { recursive: true, force: true });
  }
});

function pageView(route: string): AnalyticsEvent {
  return { name: "page_viewed", occurredAt: new Date().toISOString(), route };
}

describe("AnalyticsAggregateStore", () => {
  test("increments count and route breakdown for a fresh event", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    await store.recordEvents([pageView("/")], now);
    const file = await store.readAll();
    expect(file.byDay["2026-07-31"].events.page_viewed.count).toBe(1);
    expect(file.byDay["2026-07-31"].events.page_viewed.byRoute["/"]).toBe(1);
  });

  test("accumulates repeated events for the same day", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    await store.recordEvents(
      [pageView("/"), pageView("/"), pageView("/")],
      now,
    );
    const file = await store.readAll();
    expect(file.byDay["2026-07-31"].events.page_viewed.count).toBe(3);
  });

  test("keeps separate counts per UTC calendar day", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    await store.recordEvents(
      [pageView("/")],
      new Date("2026-07-30T23:59:00.000Z"),
    );
    await store.recordEvents(
      [pageView("/")],
      new Date("2026-07-31T00:01:00.000Z"),
    );
    const file = await store.readAll();
    expect(file.byDay["2026-07-30"].events.page_viewed.count).toBe(1);
    expect(file.byDay["2026-07-31"].events.page_viewed.count).toBe(1);
  });

  test("normalizes routes before bucketing (a match id and a static route stay distinct)", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    await store.recordEvents(
      [
        pageView("/match/abc123def456"),
        pageView("/match/xyz987uvw654"),
        pageView("/league"),
      ],
      now,
    );
    const file = await store.readAll();
    expect(
      file.byDay["2026-07-31"].events.page_viewed.byRoute["/match/:id"],
    ).toBe(2);
    expect(file.byDay["2026-07-31"].events.page_viewed.byRoute["/league"]).toBe(
      1,
    );
  });

  test("tracks a bounded dimension (eventSlug) from event context", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const event: AnalyticsEvent = {
      name: "featured_event_impression",
      occurredAt: now.toISOString(),
      route: "/watch/abc123",
      context: { eventSlug: "grand-finale" },
    };
    await store.recordEvents([event, event], now);
    const file = await store.readAll();
    expect(
      file.byDay["2026-07-31"].events.featured_event_impression.byDimension
        .eventSlug["grand-finale"],
    ).toBe(2);
  });

  test("stringifies a numeric dimension (step) for build_step_reached", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const event: AnalyticsEvent = {
      name: "build_step_reached",
      occurredAt: now.toISOString(),
      route: "/build",
      context: { step: 7 },
    };
    await store.recordEvents([event], now);
    const file = await store.readAll();
    expect(
      file.byDay["2026-07-31"].events.build_step_reached.byDimension.step["7"],
    ).toBe(1);
  });

  test("caps distinct dimension keys per day, redirecting overflow to __other__", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const events: AnalyticsEvent[] = Array.from(
      { length: 305 },
      (_, index) => ({
        name: "builder_profile_opened",
        occurredAt: now.toISOString(),
        route: "/builder/x",
        context: { builderSlug: `builder-${index}` },
      }),
    );
    await store.recordEvents(events, now);
    const file = await store.readAll();
    const byBuilder =
      file.byDay["2026-07-31"].events.builder_profile_opened.byDimension
        .builderSlug;
    // 300 distinct real values plus exactly one dedicated "__other__"
    // overflow bucket — still O(1) bounded, never grows with input size.
    expect(Object.keys(byBuilder).length).toBe(301);
    expect(byBuilder.__other__).toBe(5);
  });

  test("prunes days older than the retention window on write", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    await store.recordEvents(
      [pageView("/")],
      new Date("2026-01-01T00:00:00.000Z"),
    );
    await store.recordEvents(
      [pageView("/")],
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const file = await store.readAll();
    expect(file.byDay["2026-01-01"]).toBeUndefined();
    expect(file.byDay["2026-08-01"]).toBeDefined();
  });

  test("readAll returns an empty file when nothing has been recorded", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const file = await store.readAll();
    expect(file.byDay).toEqual({});
  });

  test("serializes concurrent writes without losing an increment", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.recordEvents([pageView("/")], now),
      ),
    );
    const file = await store.readAll();
    expect(file.byDay["2026-07-31"].events.page_viewed.count).toBe(10);
  });
});

describe("aggregate query helpers", () => {
  test("totalEventCount sums across every retained day", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    await store.recordEvents(
      [pageView("/")],
      new Date("2026-07-29T00:00:00.000Z"),
    );
    await store.recordEvents(
      [pageView("/")],
      new Date("2026-07-30T00:00:00.000Z"),
    );
    const file = await store.readAll();
    expect(totalEventCount(file, "page_viewed")).toBe(2);
    expect(totalEventCount(file, "claim_started")).toBe(0);
  });

  test("trailingEventCount only sums days within the trailing window", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-08-01T00:00:00.000Z");
    await store.recordEvents(
      [pageView("/")],
      new Date("2026-07-20T00:00:00.000Z"),
    ); // 12 days ago
    await store.recordEvents(
      [pageView("/")],
      new Date("2026-07-30T00:00:00.000Z"),
    ); // within 7 days
    const file = await store.readAll();
    expect(trailingEventCount(file, "page_viewed", 7, now)).toBe(1);
    expect(trailingEventCount(file, "page_viewed", 30, now)).toBe(2);
  });

  test("mergedRouteCounts and mergedDimensionCounts merge across days", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-agg-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const dayOneEvent: AnalyticsEvent = {
      name: "replay_load_failed",
      occurredAt: new Date().toISOString(),
      route: "/watch/1",
      context: { reason: "timeout" },
    };
    const dayTwoEvent: AnalyticsEvent = {
      name: "replay_load_failed",
      occurredAt: new Date().toISOString(),
      route: "/watch/2",
      context: { reason: "timeout" },
    };
    await store.recordEvents(
      [dayOneEvent],
      new Date("2026-07-30T00:00:00.000Z"),
    );
    await store.recordEvents(
      [dayTwoEvent],
      new Date("2026-07-31T00:00:00.000Z"),
    );
    const file = await store.readAll();
    expect(mergedRouteCounts(file, "replay_load_failed")).toEqual({
      "/watch/:id": 2,
    });
    expect(mergedDimensionCounts(file, "replay_load_failed", "reason")).toEqual(
      { timeout: 2 },
    );
  });
});
