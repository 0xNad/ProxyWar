import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AnalyticsClient } from "../../../src/client/analytics/AnalyticsClient";
import type { AnalyticsBatch } from "../../../src/client/analytics/AnalyticsEvents";

let client: AnalyticsClient | undefined;

beforeEach(() => {
  delete window.__PROXYWAR_STATIC_REPLAY__;
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  delete window.__PROXYWAR_STATIC_REPLAY__;
  client?.stop();
  client = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function lastRequestBatch(fetchMock: ReturnType<typeof vi.fn>): AnalyticsBatch {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(call[1].body as string) as AnalyticsBatch;
}

describe("AnalyticsClient", () => {
  test("stays inert in the standalone static replay viewer", () => {
    window.__PROXYWAR_STATIC_REPLAY__ = true;
    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.track("replay_load_started");
    client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("track() queues an event with the current pathname and no-ops until flushed", async () => {
    window.history.pushState({}, "", "/watch/abc123");
    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.track("page_viewed");
    expect(fetch).not.toHaveBeenCalled();
    client.flush();
    const batch = lastRequestBatch(fetch as ReturnType<typeof vi.fn>);
    expect(batch.events[0].name).toBe("page_viewed");
    expect(batch.events[0].route).toBe("/watch/abc123");
  });

  test("flush() sends the full batch envelope with schemaVersion and a stable visitorId", async () => {
    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.track("build_flow_started");
    client.track("build_step_reached", { step: 2 });
    client.flush();
    const batch = lastRequestBatch(fetch as ReturnType<typeof vi.fn>);
    expect(batch.schemaVersion).toBe(1);
    expect(typeof batch.visitorId).toBe("string");
    expect(batch.events).toHaveLength(2);
    expect(batch.events[1].context).toEqual({ step: 2 });
  });

  test("flush() clears the queue so a second flush with nothing new sends nothing", async () => {
    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.track("page_viewed");
    client.flush();
    const callCountAfterFirstFlush = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    client.flush();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountAfterFirstFlush);
  });

  test("drops events past the bounded queue size rather than growing without bound", () => {
    client = new AnalyticsClient({ flushIntervalMs: 1_000_000, maxQueueSize: 3 });
    for (let i = 0; i < 10; i++) {
      client.track("page_viewed");
    }
    client.flush();
    const batch = lastRequestBatch(fetch as ReturnType<typeof vi.fn>);
    expect(batch.events).toHaveLength(3);
  });

  test("trackVisitStart() emits page_viewed only for a brand-new visitor", () => {
    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.trackVisitStart();
    client.flush();
    const batch = lastRequestBatch(fetch as ReturnType<typeof vi.fn>);
    expect(batch.events.map((event) => event.name)).toEqual(["page_viewed"]);
  });

  test("trackVisitStart() also emits returning_anonymous_visitor for a visitor id that already existed", () => {
    // Prime storage with an existing, un-rotated visitor identity.
    const priming = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    priming.track("page_viewed");
    priming.stop();

    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.trackVisitStart();
    client.flush();
    const batch = lastRequestBatch(fetch as ReturnType<typeof vi.fn>);
    expect(batch.events.map((event) => event.name)).toEqual([
      "page_viewed",
      "returning_anonymous_visitor",
    ]);
  });

  test("trackVisitStart({ authenticated: true }) emits returning_authenticated_visitor instead", () => {
    const priming = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    priming.track("page_viewed");
    priming.stop();

    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.trackVisitStart({ authenticated: true });
    client.flush();
    const batch = lastRequestBatch(fetch as ReturnType<typeof vi.fn>);
    expect(batch.events.map((event) => event.name)).toEqual([
      "page_viewed",
      "returning_authenticated_visitor",
    ]);
  });

  test("does NOT re-emit returning_anonymous_visitor on a second page load the SAME day — same-day/same-session navigation must never inflate the return metric", () => {
    // Prime storage with an existing, un-rotated visitor identity.
    const priming = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    priming.track("page_viewed");
    priming.stop();

    // First "page load" of the day: the visitor id already existed, so
    // this DOES fire returning_anonymous_visitor.
    const first = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    first.trackVisitStart();
    first.flush();
    expect(
      lastRequestBatch(fetch as ReturnType<typeof vi.fn>).events.map(
        (event) => event.name,
      ),
    ).toEqual(["page_viewed", "returning_anonymous_visitor"]);
    first.stop();

    // A SECOND page load (a fresh client instance — exactly what a real
    // browser navigation produces, a brand-new JS context) later the SAME
    // day must NOT re-emit returning_anonymous_visitor: it is still the
    // same UTC day the first load already counted.
    const second = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    second.trackVisitStart();
    second.flush();
    expect(
      lastRequestBatch(fetch as ReturnType<typeof vi.fn>).events.map(
        (event) => event.name,
      ),
    ).toEqual(["page_viewed"]);
    second.stop();

    // A third load also stays silent on the returning event.
    const third = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    third.trackVisitStart();
    third.flush();
    expect(
      lastRequestBatch(fetch as ReturnType<typeof vi.fn>).events.map(
        (event) => event.name,
      ),
    ).toEqual(["page_viewed"]);
  });

  test("flush(true) prefers navigator.sendBeacon over fetch when it succeeds", () => {
    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeaconMock,
      configurable: true,
    });
    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.track("page_viewed");
    client.flush(true);
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("flush(true) falls back to fetch when sendBeacon reports failure", () => {
    Object.defineProperty(navigator, "sendBeacon", {
      value: vi.fn(() => false),
      configurable: true,
    });
    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.track("page_viewed");
    client.flush(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("the automatic flush interval sends whatever is queued without an explicit flush() call", () => {
    vi.useFakeTimers();
    client = new AnalyticsClient({ flushIntervalMs: 5_000 });
    client.track("page_viewed");
    expect(fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("stop() detaches the pagehide listener so a later pagehide no longer triggers a flush", () => {
    client = new AnalyticsClient({ flushIntervalMs: 1_000_000 });
    client.track("page_viewed");
    client.stop();
    window.dispatchEvent(new Event("pagehide"));
    expect(fetch).not.toHaveBeenCalled();
  });
});
