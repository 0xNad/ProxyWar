import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AnalyticsRecentRing } from "../../../src/server/analytics/AnalyticsRecentRing";
import type { AnalyticsEvent } from "../../../src/server/analytics/AnalyticsEventSchema";

let artifactsRoot: string;

afterEach(async () => {
  if (artifactsRoot !== undefined) {
    await rm(artifactsRoot, { recursive: true, force: true });
  }
});

describe("AnalyticsRecentRing", () => {
  test("appends an event with its normalized route and no visitor id field", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-ring-"));
    const ring = new AnalyticsRecentRing(artifactsRoot);
    const event: AnalyticsEvent = {
      name: "replay_load_failed",
      occurredAt: new Date().toISOString(),
      route: "/watch/abc123def456",
      context: { reason: "timeout" },
    };
    await ring.pushEvents([event]);
    const entries = await ring.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("replay_load_failed");
    expect(entries[0].route).toBe("/watch/:id");
    expect(entries[0].reason).toBe("timeout");
    expect(Object.keys(entries[0])).not.toContain("visitorId");
  });

  test("omits the reason field entirely when the event has none", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-ring-"));
    const ring = new AnalyticsRecentRing(artifactsRoot);
    await ring.pushEvents([{ name: "page_viewed", occurredAt: new Date().toISOString(), route: "/" }]);
    const entries = await ring.readAll();
    expect(entries[0].reason).toBeUndefined();
  });

  test("drops the oldest entries once the ring exceeds its fixed capacity", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-ring-"));
    const ring = new AnalyticsRecentRing(artifactsRoot);
    const events: AnalyticsEvent[] = Array.from({ length: 250 }, (_, index) => ({
      name: "page_viewed",
      occurredAt: new Date().toISOString(),
      route: `/page/${index}`,
    }));
    await ring.pushEvents(events);
    const entries = await ring.readAll();
    expect(entries.length).toBeLessThanOrEqual(200);
    // The most recent entries survive, not the oldest.
    expect(entries[entries.length - 1].route).toBe("/page/:id");
  });

  test("readAll returns an empty array when nothing has been pushed", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-ring-"));
    const ring = new AnalyticsRecentRing(artifactsRoot);
    expect(await ring.readAll()).toEqual([]);
  });
});
