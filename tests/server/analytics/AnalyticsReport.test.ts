import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AnalyticsAggregateStore } from "../../../src/server/analytics/AnalyticsAggregateStore";
import type { AnalyticsEvent } from "../../../src/server/analytics/AnalyticsEventSchema";
import {
  applyMatchLabels,
  buildAnalyticsReport,
  MIN_SAMPLE_FOR_RATE,
} from "../../../src/server/analytics/AnalyticsReport";

let artifactsRoot: string;

afterEach(async () => {
  if (artifactsRoot !== undefined) {
    await rm(artifactsRoot, { recursive: true, force: true });
  }
});

describe("buildAnalyticsReport", () => {
  test("every metric reports not_yet_instrumented when nothing has ever been recorded", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const report = buildAnalyticsReport(await store.readAll());
    expect(report.homepageToWatchCtr.status).toBe("not_yet_instrumented");
    expect(report.replayLoadSuccessRate.status).toBe("not_yet_instrumented");
    expect(report.sevenDayReturnRate.status).toBe("not_yet_instrumented");
    expect(report.returningAuthenticatedVisitors.status).toBe(
      "not_yet_instrumented",
    );
    expect(report.returningAuthenticatedVisitors.count).toBe(0);
    expect(report.sevenDayCohortReturnRate.status).toBe("not_yet_instrumented");
    expect(report.agentBuilderProfileCtr.status).toBe("not_yet_instrumented");
    expect(report.mostWatchedEvents.status).toBe("not_yet_instrumented");
    expect(report.builderFunnel.status).toBe("not_yet_instrumented");
    for (const metric of report.claimsAndReleases) {
      expect(metric.status).toBe("not_yet_instrumented");
      expect(metric.count).toBe(0);
    }
    expect(report.failuresByRoute.status).toBe("not_yet_instrumented");
  });

  test("reports insufficient_traffic (raw counts, no percentage) below the minimum sample size", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const started = MIN_SAMPLE_FOR_RATE - 1;
    const events: AnalyticsEvent[] = Array.from({ length: started }, () => ({
      name: "replay_load_started",
      occurredAt: now.toISOString(),
      route: "/watch/x",
    }));
    events.push({
      name: "replay_load_succeeded",
      occurredAt: now.toISOString(),
      route: "/watch/x",
    });
    await store.recordEvents(events, now);
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.replayLoadSuccessRate.status).toBe("insufficient_traffic");
    expect(report.replayLoadSuccessRate.ratePercent).toBeNull();
    expect(report.replayLoadSuccessRate.numerator).toBe(1);
    expect(report.replayLoadSuccessRate.denominator).toBe(started);
  });

  test("computes a real percentage once traffic clears the minimum sample size", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
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
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
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
    await store.recordEvents(
      [...homepageViews, ...otherPageViews, ...homepageClicks],
      now,
    );
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.homepageToWatchCtr.denominator).toBe(25);
    expect(report.homepageToWatchCtr.numerator).toBe(5);
    expect(report.homepageToWatchCtr.status).toBe("measured");
    expect(report.homepageToWatchCtr.ratePercent).toBe(20);
  });

  test("seven-day return rate only counts events within the trailing window", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
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
    await store.recordEvents(
      [...recentViews, ...recentReturns],
      new Date("2026-07-30T00:00:00.000Z"),
    );
    // Outside the trailing 7-day window from `now` — must not count.
    await store.recordEvents(
      [
        {
          name: "returning_anonymous_visitor",
          occurredAt: now.toISOString(),
          route: "/",
        },
      ],
      new Date("2026-07-01T00:00:00.000Z"),
    );
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.sevenDayReturnRate.numerator).toBe(6);
    expect(report.sevenDayReturnRate.denominator).toBe(30);
  });

  test("most-watched events ranks matches by replay_load_started count, descending", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const events: AnalyticsEvent[] = [
      ...Array.from(
        { length: 3 },
        (): AnalyticsEvent => ({
          name: "replay_load_started",
          occurredAt: now.toISOString(),
          route: "/watch/a",
          context: { matchId: "match_grand_finale" },
        }),
      ),
      ...Array.from(
        { length: 7 },
        (): AnalyticsEvent => ({
          name: "replay_load_started",
          occurredAt: now.toISOString(),
          route: "/watch/b",
          context: { matchId: "match_opening_clash" },
        }),
      ),
    ];
    await store.recordEvents(events, now);
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.mostWatchedEvents.items[0]).toEqual({
      key: "match_opening_clash",
      count: 7,
    });
    expect(report.mostWatchedEvents.items[1]).toEqual({
      key: "match_grand_finale",
      count: 3,
    });
  });

  test("applyMatchLabels resolves ranking keys to a human label, falling back to the raw key on a lookup miss", () => {
    const ranking = {
      id: "most_watched_events",
      label: "Most-watched matches",
      status: "measured" as const,
      items: [
        { key: "match_abc", count: 5 },
        { key: "match_unknown", count: 2 },
      ],
      methodology: "test",
    };
    const labeled = applyMatchLabels(ranking, (key) =>
      key === "match_abc" ? "Grand Finale" : null,
    );
    expect(labeled.items).toEqual([
      { key: "Grand Finale", count: 5 },
      { key: "match_unknown", count: 2 },
    ]);
    // Counts, status, and every other field pass through untouched.
    expect(labeled.status).toBe("measured");
  });

  test("full-replay milestones report the total count of watch-milestone events (no mode filtering)", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const events: AnalyticsEvent[] = Array.from(
      { length: 25 },
      (): AnalyticsEvent => ({
        name: "watched_30s",
        occurredAt: now.toISOString(),
        route: "/watch/a",
        context: { matchId: "match_a" },
      }),
    );
    await store.recordEvents(events, now);
    const report = buildAnalyticsReport(await store.readAll(), now);
    const watched30s = report.fullReplayMilestones.find(
      (metric) => metric.id === "full_replay_watched_30s",
    );
    expect(watched30s?.count).toBe(25);
    expect(watched30s?.status).toBe("measured");
  });

  test("returning-visitor-day share reports raw counts (formula unchanged — the client-side daily gate is what bounds the numerator)", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-08-01T00:00:00.000Z");
    // Simulates the FIXED client: at most one returning_anonymous_visitor
    // per visitor per UTC day, regardless of how many pages that visitor
    // loaded that day.
    const events: AnalyticsEvent[] = [
      ...Array.from(
        { length: 30 },
        (): AnalyticsEvent => ({
          name: "page_viewed",
          occurredAt: now.toISOString(),
          route: "/",
        }),
      ),
      ...Array.from(
        { length: 6 },
        (): AnalyticsEvent => ({
          name: "returning_anonymous_visitor",
          occurredAt: now.toISOString(),
          route: "/",
        }),
      ),
    ];
    await store.recordEvents(events, new Date("2026-07-30T00:00:00.000Z"));
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.sevenDayReturnRate.label).toContain("Returning-visitor-day");
    expect(report.sevenDayReturnRate.numerator).toBe(6);
    expect(report.sevenDayReturnRate.denominator).toBe(30);
    expect(report.sevenDayReturnRate.methodology).toContain(
      "capped at ONE emission per visitor id per UTC day",
    );
  });

  test("a plain returning GUEST (returning_anonymous_visitor only) counts as exactly ONE numerator event toward sevenDayReturnRate — never doubled by an auto-minted platform-account cookie", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-08-01T00:00:00.000Z");
    // A single returning guest visit: the client emits ONE
    // returning_anonymous_visitor. It must NOT also count toward
    // returning_authenticated_visitor just because every visitor (guest
    // or not) carries an auto-minted platform-account cookie server-side.
    const events: AnalyticsEvent[] = [
      { name: "page_viewed", occurredAt: now.toISOString(), route: "/" },
      {
        name: "returning_anonymous_visitor",
        occurredAt: now.toISOString(),
        route: "/",
      },
    ];
    await store.recordEvents(events, new Date("2026-07-30T00:00:00.000Z"));
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.sevenDayReturnRate.numerator).toBe(1);
    expect(report.sevenDayReturnRate.denominator).toBe(1);
    expect(report.returningAuthenticatedVisitors.count).toBe(0);
  });

  test("a genuinely signed-in return adds to returningAuthenticatedVisitors's raw count WITHOUT touching sevenDayReturnRate's numerator or denominator", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-08-01T00:00:00.000Z");
    const events: AnalyticsEvent[] = [
      // One returning guest (anonymous share numerator)...
      { name: "page_viewed", occurredAt: now.toISOString(), route: "/" },
      {
        name: "returning_anonymous_visitor",
        occurredAt: now.toISOString(),
        route: "/",
      },
      // ...and, on a SEPARATE page view, one genuinely signed-in return —
      // server-emitted, never client-emitted, so it never inflates
      // returning_anonymous_visitor either.
      { name: "page_viewed", occurredAt: now.toISOString(), route: "/" },
      {
        name: "returning_authenticated_visitor",
        occurredAt: now.toISOString(),
        route: "/",
      },
    ];
    await store.recordEvents(events, new Date("2026-07-30T00:00:00.000Z"));
    const report = buildAnalyticsReport(await store.readAll(), now);
    // The share metric only ever reflects returning_anonymous_visitor.
    expect(report.sevenDayReturnRate.numerator).toBe(1);
    expect(report.sevenDayReturnRate.denominator).toBe(2);
    // The signed-in return shows up ONLY in its own separate raw count.
    expect(report.returningAuthenticatedVisitors.count).toBe(1);
    expect(report.returningAuthenticatedVisitors.status).toBe("measured");
  });

  test("sevenDayCohortReturnRate is always not_yet_instrumented — never silently substitutes the day-share proxy for a real N-days-later cohort", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-08-01T00:00:00.000Z");
    // Plenty of traffic — enough to clear MIN_SAMPLE_FOR_RATE on every
    // OTHER metric — but the cohort metric has no data source at all and
    // must stay honestly not_yet_instrumented regardless.
    const events: AnalyticsEvent[] = [
      ...Array.from(
        { length: 50 },
        (): AnalyticsEvent => ({
          name: "page_viewed",
          occurredAt: now.toISOString(),
          route: "/",
        }),
      ),
      ...Array.from(
        { length: 30 },
        (): AnalyticsEvent => ({
          name: "returning_anonymous_visitor",
          occurredAt: now.toISOString(),
          route: "/",
        }),
      ),
    ];
    await store.recordEvents(events, now);
    const report = buildAnalyticsReport(await store.readAll(), now);
    expect(report.sevenDayCohortReturnRate.status).toBe("not_yet_instrumented");
    expect(report.sevenDayCohortReturnRate.ratePercent).toBeNull();
    expect(report.sevenDayCohortReturnRate.methodology).toContain(
      "NOT IMPLEMENTED",
    );
  });

  test("builder funnel reports raw stage counts, including the final-step breakdown", async () => {
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-analytics-report-"),
    );
    const store = new AnalyticsAggregateStore(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    const events: AnalyticsEvent[] = [
      {
        name: "build_flow_started",
        occurredAt: now.toISOString(),
        route: "/build",
      },
      {
        name: "build_flow_started",
        occurredAt: now.toISOString(),
        route: "/build",
      },
      {
        name: "build_step_reached",
        occurredAt: now.toISOString(),
        route: "/build",
        context: { step: 3 },
      },
      {
        name: "build_step_reached",
        occurredAt: now.toISOString(),
        route: "/build",
        context: { step: 7 },
      },
      {
        name: "registration_draft_submitted",
        occurredAt: now.toISOString(),
        route: "/build",
      },
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
