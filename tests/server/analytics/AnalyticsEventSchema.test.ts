import { describe, expect, test } from "vitest";
import {
  ANALYTICS_EVENT_NAMES,
  AnalyticsBatchSchema,
  AnalyticsEventSchema,
  normalizeAnalyticsRoute,
} from "../../../src/server/analytics/AnalyticsEventSchema";

function validBatch(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    visitorId: "visitor_abc12345",
    events: [{ name: "page_viewed", occurredAt: new Date().toISOString(), route: "/" }],
    ...overrides,
  };
}

describe("AnalyticsEventSchema", () => {
  test("accepts every catalog event name", () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      const result = AnalyticsEventSchema.safeParse({
        name,
        occurredAt: new Date().toISOString(),
        route: "/watch/abc123def456",
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects an unknown event name", () => {
    const result = AnalyticsEventSchema.safeParse({
      name: "totally_made_up_event",
      occurredAt: new Date().toISOString(),
      route: "/",
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown context field (strict schema)", () => {
    const result = AnalyticsEventSchema.safeParse({
      name: "page_viewed",
      occurredAt: new Date().toISOString(),
      route: "/",
      context: { userEmail: "nope@example.com" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects an out-of-range build step", () => {
    const result = AnalyticsEventSchema.safeParse({
      name: "build_step_reached",
      occurredAt: new Date().toISOString(),
      route: "/build",
      context: { step: 99 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects a reason field carrying free text instead of a bounded code", () => {
    const result = AnalyticsEventSchema.safeParse({
      name: "replay_load_failed",
      occurredAt: new Date().toISOString(),
      route: "/watch/x",
      context: { reason: "The user's connection to 10.0.0.1 dropped mid-request!" },
    });
    expect(result.success).toBe(false);
  });

  test("accepts a well-formed bounded context", () => {
    const result = AnalyticsEventSchema.safeParse({
      name: "replay_load_failed",
      occurredAt: new Date().toISOString(),
      route: "/watch/x",
      context: { matchId: "match_00123", reason: "timeout" },
    });
    expect(result.success).toBe(true);
  });
});

describe("AnalyticsBatchSchema", () => {
  test("accepts a well-formed single-event batch", () => {
    expect(AnalyticsBatchSchema.safeParse(validBatch()).success).toBe(true);
  });

  test("rejects a batch with zero events", () => {
    expect(AnalyticsBatchSchema.safeParse(validBatch({ events: [] })).success).toBe(false);
  });

  test("rejects a batch above the size cap", () => {
    const events = Array.from({ length: 26 }, () => ({
      name: "page_viewed",
      occurredAt: new Date().toISOString(),
      route: "/",
    }));
    expect(AnalyticsBatchSchema.safeParse(validBatch({ events })).success).toBe(false);
  });

  test("accepts a batch exactly at the size cap", () => {
    const events = Array.from({ length: 25 }, () => ({
      name: "page_viewed",
      occurredAt: new Date().toISOString(),
      route: "/",
    }));
    expect(AnalyticsBatchSchema.safeParse(validBatch({ events })).success).toBe(true);
  });

  test("rejects a schema version other than the current one", () => {
    expect(AnalyticsBatchSchema.safeParse(validBatch({ schemaVersion: 2 })).success).toBe(false);
  });

  test("rejects a visitor id that's too short to be a real random id", () => {
    expect(AnalyticsBatchSchema.safeParse(validBatch({ visitorId: "abc" })).success).toBe(false);
  });

  test("rejects an unexpected top-level field (strict batch envelope)", () => {
    expect(
      AnalyticsBatchSchema.safeParse(validBatch({ ipAddress: "203.0.113.9" })).success,
    ).toBe(false);
  });
});

describe("normalizeAnalyticsRoute", () => {
  test("keeps a short static route unchanged", () => {
    expect(normalizeAnalyticsRoute("/league")).toBe("/league");
  });

  test("collapses a long id-like segment to :id", () => {
    expect(normalizeAnalyticsRoute("/match/abc123def456ghi789")).toBe("/match/:id");
  });

  test("collapses a purely numeric segment to :id", () => {
    expect(normalizeAnalyticsRoute("/round/503")).toBe("/round/:id");
  });

  test("caps at three path segments", () => {
    expect(normalizeAnalyticsRoute("/a/b/c/d/e")).toBe("/a/b/c");
  });

  test("strips query strings and hashes before normalizing", () => {
    expect(normalizeAnalyticsRoute("/watch/abc123def456?x=1#y")).toBe("/watch/:id");
  });

  test("returns / for the root path", () => {
    expect(normalizeAnalyticsRoute("/")).toBe("/");
  });
});
