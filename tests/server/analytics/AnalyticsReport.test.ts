import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AnalyticsAggregateStore } from "../../../src/server/analytics/AnalyticsAggregateStore";
import type { AnalyticsEvent } from "../../../src/server/analytics/AnalyticsEventSchema";
import { buildAnalyticsReport, MIN_SAMPLE_FOR_RATE } from "../../../src/server/analytics/AnalyticsReport";

let artifactsRoot: string;

afterEach(async () => {
  if (artifactsRoot !== undefined) {
    await rm(artifactsRoot, { recursive: true, force: true });
  }
});

describe("buildAnalyticsReport", () => {
  test("every metric reports not_yet_instrumented when nothing has ever been recorded", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-report-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const report = buildAnalyticsReport(await store.readAll());
    expect(report.homepageToWatchCtr.status).toBe("not_yet_instrumented");
    expect(report.replayLoadSuccessRate.status).toBe("not_yet_instrumented");
    expect(report.sevenDayReturnRate.status).toBe("not_yet_instrumented");
    expect(report.agentBuilderProfileCtr.status).toBe("not_yet_instrumented");
    for (const milestone of report.directorCutMilestones) {
      expect(milestone.status).toBe("not_yet_instrumented");
    }
    expect(report.mostWatchedEvents.status).toBe("not_yet_instrumented");
    expect(report.builderFunnel.status).toBe("not_yet_instrumented");
    for (const metric of report.claimsAndReleases) {
      expect(metric.status).toBe("not_yet_instrumented");
      expect(metric.count).toBe(0);
    }
    expect(report.failuresByRoute.status).toBe("not_yet_instrumented");
  });

  test("reports insufficient_traffic (raw counts, no percentage) below the minimum sample size", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-report-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const started = MIN_SAMPLE_FOR_RATE - 1;
    const events: AnalyticsEvent[] = Array.from({ length: started }, () => ({
      name: "replay_load_started",
      occurredAt: now.toISOString(),
      route: "/watch/x",
    }));
    events.push({ name: "replay_load_succeeded", occurredAt: now.toISOString(), route: "/watch/x" });
    await store.recordEvents(events, now);
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.replayLoadSuccessRate.status).toBe("insufficient_traffic");
    expect(report.replayLoadSuccessRate.ratePercent).toBeNull();
    expect(report.replayLoadSuccessRate.numerator).toBe(1);
    expect(report.replayLoadSuccessRate.denominator).toBe(started);
  });

  test("computes a real percentage once traffic clears the minimum sample size", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-report-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const started: AnalyticsEvent[] = Array.from({ length: 40 }, () => ({
      name: "replay_load_started",
      occurredAt: now.toISOString(),
      route: "/watch/x",
    }));
    const succeeded: AnalyticsEvent[] = Array.from({ length: 30 }, () => ({
      name: "replay_load_succeeded",
      occurredAt: now.toISOString(),
      route: "/watch/x",
    }));
    await store.recordEvents([...started, ...succeeded], now);
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.replayLoadSuccessRate.status).toBe("measured");
    expect(report.replayLoadSuccessRate.ratePercent).toBe(75);
  });

  test("homepage-to-watch CTR is scoped to the root route only", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-report-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const homepageViews: AnalyticsEvent[] = Array.from({ length: 25 }, () => ({
      name: "page_viewed",
      occurredAt: now.toISOString(),
      route: "/",
    }));
    const otherPageViews: AnalyticsEvent[] = Array.from({ length: 25 }, () => ({
      name: "page_viewed",
      occurredAt: now.toISOString(),
      route: "/league",
    }));
    const homepageClicks: AnalyticsEvent[] = Array.from({ length: 5 }, () => ({
      name: "event_cta_clicked",
      occurredAt: now.toISOString(),
      route: "/",
    }));
    await store.recordEvents([...homepageViews, ...otherPageViews, ...homepageClicks], now);
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.homepageToWatchCtr.denominator).toBe(25);
    expect(report.homepageToWatchCtr.numerator).toBe(5);
    expect(report.homepageToWatchCtr.status).toBe("measured");
    expect(report.homepageToWatchCtr.ratePercent).toBe(20);
  });

  test("seven-day return rate only counts events within the trailing window", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-report-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-08-01T00:00:00.000Z");
    const recentViews: AnalyticsEvent[] = Array.from({ length: 30 }, () => ({
      name: "page_viewed",
      occurredAt: now.toISOString(),
      route: "/",
    }));
    const recentReturns: AnalyticsEvent[] = Array.from({ length: 6 }, () => ({
      name: "returning_anonymous_visitor",
      occurredAt: now.toISOString(),
      route: "/",
    }));
    await store.recordEvents([...recentViews, ...recentReturns], new Date("2026-07-30T00:00:00.000Z"));
    // Outside the trailing 7-day window from `now` — must not count.
    await store.recordEvents(
      [{ name: "returning_anonymous_visitor", occurredAt: now.toISOString(), route: "/" }],
      new Date("2026-07-01T00:00:00.000Z"),
    );
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.sevenDayReturnRate.numerator).toBe(6);
    expect(report.sevenDayReturnRate.denominator).toBe(30);
  });

  test("most-watched events ranks Featured Event slugs by director_cut_started count, descending", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-report-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const events: AnalyticsEvent[] = [
      ...Array.from({ length: 3 }, (): AnalyticsEvent => ({
        name: "director_cut_started",
        occurredAt: now.toISOString(),
        route: "/watch/a",
        context: { eventSlug: "grand-finale" },
      })),
      ...Array.from({ length: 7 }, (): AnalyticsEvent => ({
        name: "director_cut_started",
        occurredAt: now.toISOString(),
        route: "/watch/b",
        context: { eventSlug: "opening-clash" },
      })),
    ];
    await store.recordEvents(events, now);
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.mostWatchedEvents.items[0]).toEqual({ key: "opening-clash", count: 7 });
    expect(report.mostWatchedEvents.items[1]).toEqual({ key: "grand-finale", count: 3 });
  });

  test("builder funnel reports raw stage counts, including the final-step breakdown", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-report-"));
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const events: AnalyticsEvent[] = [
      { name: "build_flow_started", occurredAt: now.toISOString(), route: "/build" },
      { name: "build_flow_started", occurredAt: now.toISOString(), route: "/build" },
      { name: "build_step_reached", occurredAt: now.toISOString(), route: "/build", context: { step: 3 } },
      { name: "build_step_reached", occurredAt: now.toISOString(), route: "/build", context: { step: 7 } },
      { name: "registration_draft_submitted", occurredAt: now.toISOString(), route: "/build" },
    ];
    await store.recordEvents(events, now);
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.builderFunnel.stages).toEqual([
      { stage: "build_flow_started", count: 2 },
      { stage: "build_step_reached (final step)", count: 1 },
      { stage: "registration_draft_submitted", count: 1 },
    ]);
  });
});
