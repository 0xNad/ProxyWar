import { describe, expect, it } from "vitest";
import {
  normalizeOpenFrontierRateLimitSnapshot,
  OpenFrontierRateLimiter,
} from "../../src/server/agents/OpenFrontierRateLimit";

describe("OpenFrontierRateLimiter", () => {
  it("allows requests up to the configured window limit", () => {
    const limiter = new OpenFrontierRateLimiter({ windowMs: 1_000 });

    expect(
      limiter.consume({ scope: "jobs", key: "friend", limit: 2, now: 100 }).allowed,
    ).toBe(true);
    expect(
      limiter.consume({ scope: "jobs", key: "friend", limit: 2, now: 200 }).allowed,
    ).toBe(true);
    const third = limiter.consume({
      scope: "jobs",
      key: "friend",
      limit: 2,
      now: 300,
    });

    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterMs).toBe(800);
  });

  it("resets buckets after the window and separates scopes", () => {
    const limiter = new OpenFrontierRateLimiter({ windowMs: 1_000 });

    expect(
      limiter.consume({ scope: "jobs", key: "friend", limit: 1, now: 100 }).allowed,
    ).toBe(true);
    expect(
      limiter.consume({ scope: "feedback", key: "friend", limit: 1, now: 200 })
        .allowed,
    ).toBe(true);
    expect(
      limiter.consume({ scope: "jobs", key: "friend", limit: 1, now: 1_101 })
        .allowed,
    ).toBe(true);
  });

  it("snapshots and restores unexpired buckets", () => {
    const limiter = new OpenFrontierRateLimiter({ windowMs: 1_000, now: 100 });
    limiter.consume({ scope: "jobs", key: "friend", limit: 2, now: 100 });
    limiter.consume({ scope: "jobs", key: "friend", limit: 2, now: 200 });

    const restored = new OpenFrontierRateLimiter({
      windowMs: 1_000,
      initialSnapshot: limiter.snapshot(300),
      now: 300,
    });

    expect(
      restored.consume({ scope: "jobs", key: "friend", limit: 2, now: 400 })
        .allowed,
    ).toBe(false);
    expect(restored.snapshot(1_200).buckets).toHaveLength(0);
  });

  it("normalizes persisted snapshots defensively", () => {
    const snapshot = normalizeOpenFrontierRateLimitSnapshot({
      buckets: [
        { key: "jobs:friend", count: 2.8, resetAt: 1_000.9 },
        { key: "bad\nkey", count: 1, resetAt: 1_000 },
        { key: "jobs:broken", count: "nope", resetAt: 1_000 },
      ],
    });

    expect(snapshot?.buckets).toEqual([
      { key: "jobs:friend", count: 2, resetAt: 1_000 },
    ]);
  });
});
