import { describe, expect, it, vi } from "vitest";

import { CoworldGlobalPingBarrier } from "./coworld-global-ping-barrier";

describe("CoworldGlobalPingBarrier", () => {
  it("does not delay teardown when no global client connected", async () => {
    const barrier = new CoworldGlobalPingBarrier();
    await expect(barrier.waitForPingOrGrace()).resolves.toBeUndefined();
  });

  it("holds a connected fast episode through the queued Pong flush", async () => {
    vi.useFakeTimers();
    try {
      const barrier = new CoworldGlobalPingBarrier();
      const connectionID = barrier.connected();

      let settled = false;
      const waiting = barrier.waitForPingOrGrace(10_000).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      barrier.observedPing(connectionID);
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is bounded when a non-sentinel viewer never sends Ping", async () => {
    vi.useFakeTimers();
    try {
      const barrier = new CoworldGlobalPingBarrier();
      barrier.connected();
      const waiting = barrier.waitForPingOrGrace(2_000);

      await vi.advanceTimersByTimeAsync(1_999);
      let settled = false;
      void waiting.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when the last global client disconnects", async () => {
    const barrier = new CoworldGlobalPingBarrier();
    const connectionID = barrier.connected();
    const waiting = barrier.waitForPingOrGrace(10_000);

    barrier.disconnected(connectionID);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("does not reuse a Ping from a disconnected earlier viewer", async () => {
    vi.useFakeTimers();
    try {
      const barrier = new CoworldGlobalPingBarrier();
      const earlier = barrier.connected();
      barrier.observedPing(earlier);
      barrier.disconnected(earlier);
      const sentinel = barrier.connected();

      let settled = false;
      const waiting = barrier.waitForPingOrGrace(10_000).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      barrier.observedPing(sentinel);
      await vi.advanceTimersByTimeAsync(100);
      await expect(waiting).resolves.toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending flush when the pinging viewer disconnects", async () => {
    vi.useFakeTimers();
    try {
      const barrier = new CoworldGlobalPingBarrier();
      const earlier = barrier.connected();
      let settled = false;
      const waiting = barrier.waitForPingOrGrace(10_000).then(() => {
        settled = true;
      });

      barrier.observedPing(earlier);
      const sentinel = barrier.connected();
      barrier.disconnected(earlier);
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      barrier.observedPing(sentinel);
      await vi.advanceTimersByTimeAsync(100);
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a hard bound when a late pinging viewer disconnects", async () => {
    vi.useFakeTimers();
    try {
      const barrier = new CoworldGlobalPingBarrier();
      const earlier = barrier.connected();
      barrier.connected();
      let settled = false;
      const waiting = barrier.waitForPingOrGrace(2_000).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_950);
      barrier.observedPing(earlier);
      await vi.advanceTimersByTimeAsync(50);
      barrier.disconnected(earlier);
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still flushes when the Ping arrived just before teardown begins", async () => {
    vi.useFakeTimers();
    try {
      const barrier = new CoworldGlobalPingBarrier();
      const connectionID = barrier.connected();
      barrier.observedPing(connectionID);

      let settled = false;
      const waiting = barrier.waitForPingOrGrace(2_000).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
