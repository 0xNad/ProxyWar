import {
  type AnalyticsAggregateFile,
  mergedDimensionCounts,
  mergedRouteCounts,
  totalEventCount,
  trailingEventCount,
} from "./AnalyticsAggregateStore";
import type { AnalyticsEventName } from "./AnalyticsEventSchema";

/**
 * Turns the durable aggregate file into the operator report the phase brief
 * asks for (homepage→watch CTR, replay success, Director Cut milestones,
 * most-watched events, agent-profile CTR, 7-day return, build funnel,
 * claims/releases, failures by route). Every metric is honestly labeled:
 *
 *  - `not_yet_instrumented`: the event(s) this metric needs have NEVER been
 *    recorded (all-time count is 0) — true right now for every metric,
 *    since this phase intentionally ships the collector without wiring any
 *    page to call it (that's a later pass). This is the "honest zero" the
 *    brief requires instead of a fabricated number.
 *  - `insufficient_traffic`: some data exists but the denominator is below
 *    `MIN_SAMPLE_FOR_RATE` — Season Zero's own rule ("if traffic is too
 *    small for a meaningful percentage, report raw counts and do not
 *    overinterpret them") means we show the raw counts and withhold a
 *    misleadingly precise percentage.
 *  - `measured`: enough traffic to report a percentage.
 */

export const MIN_SAMPLE_FOR_RATE = 20;

export type MetricStatus = "measured" | "insufficient_traffic" | "not_yet_instrumented";

export interface RateMetric {
  id: string;
  label: string;
  status: MetricStatus;
  numerator: number;
  denominator: number;
  ratePercent: number | null;
  methodology: string;
}

export interface CountMetric {
  id: string;
  label: string;
  status: MetricStatus;
  count: number;
  methodology: string;
}

export interface RankingMetric {
  id: string;
  label: string;
  status: MetricStatus;
  items: Array<{ key: string; count: number }>;
  methodology: string;
}

export interface RouteBreakdownMetric {
  id: string;
  label: string;
  status: MetricStatus;
  items: Array<{ route: string; count: number }>;
  methodology: string;
}

export interface FunnelStageMetric {
  id: string;
  label: string;
  status: MetricStatus;
  stages: Array<{ stage: string; count: number }>;
  methodology: string;
}

export interface AnalyticsReportModel {
  generatedAt: string;
  homepageToWatchCtr: RateMetric;
  replayLoadSuccessRate: RateMetric;
  directorCutMilestones: RateMetric[];
  /** Same milestone events (`watched_30s`/`watched_2m`/`watched_50pct`/`completed`) filtered to `replayMode=full_replay` — reported as raw counts, not rates: unlike Director Cut, Full Replay has no "started" baseline event to divide by. */
  fullReplayMilestones: CountMetric[];
  mostWatchedEvents: RankingMetric;
  agentBuilderProfileCtr: RateMetric;
  sevenDayReturnRate: RateMetric;
  builderFunnel: FunnelStageMetric;
  claimsAndReleases: CountMetric[];
  failuresByRoute: RouteBreakdownMetric;
  failureReasons: RankingMetric;
}

function rateMetric(input: {
  id: string;
  label: string;
  numerator: number;
  denominator: number;
  methodology: string;
}): RateMetric {
  const status: MetricStatus =
    input.denominator === 0
      ? "not_yet_instrumented"
      : input.denominator < MIN_SAMPLE_FOR_RATE
        ? "insufficient_traffic"
        : "measured";
  const ratePercent =
    status === "measured" ? Math.round((input.numerator / input.denominator) * 1000) / 10 : null;
  return { ...input, status, ratePercent };
}

function countMetric(id: string, label: string, count: number, methodology: string): CountMetric {
  return { id, label, status: count === 0 ? "not_yet_instrumented" : "measured", count, methodology };
}

function rankingMetric(
  id: string,
  label: string,
  counts: Record<string, number>,
  methodology: string,
  limit = 10,
): RankingMetric {
  const items = Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  return { id, label, status: items.length === 0 ? "not_yet_instrumented" : "measured", items, methodology };
}

function routeBreakdownMetric(
  id: string,
  label: string,
  counts: Record<string, number>,
  methodology: string,
): RouteBreakdownMetric {
  const items = Object.entries(counts)
    .map(([route, count]) => ({ route, count }))
    .sort((a, b) => b.count - a.count);
  return { id, label, status: items.length === 0 ? "not_yet_instrumented" : "measured", items, methodology };
}

function totalAll(file: AnalyticsAggregateFile, names: readonly AnalyticsEventName[]): number {
  return names.reduce((sum, name) => sum + totalEventCount(file, name), 0);
}

export function buildAnalyticsReport(
  file: AnalyticsAggregateFile,
  now: Date = new Date(),
): AnalyticsReportModel {
  const homepagePageViews = mergedRouteCounts(file, "page_viewed")["/"] ?? 0;
  const homepageCtaClicks = mergedRouteCounts(file, "event_cta_clicked")["/"] ?? 0;

  const replayStarted = totalEventCount(file, "replay_load_started");
  const replaySucceeded = totalEventCount(file, "replay_load_succeeded");

  const directorCutStarted = totalEventCount(file, "director_cut_started");
  const WATCH_MILESTONES = [
    { name: "watched_30s" as const, label: "reached 30s" },
    { name: "watched_2m" as const, label: "reached 2 minutes" },
    { name: "watched_50pct" as const, label: "reached 50%" },
    { name: "completed" as const, label: "completed" },
  ];
  // Both Director Cut and Full Replay viewers emit the SAME watched_*/
  // completed event names — only `context.replayMode` distinguishes them.
  // Dividing the TOTAL (both modes combined) by `director_cut_started`
  // could exceed 100% whenever Full Replay viewers also cross a milestone;
  // filtering each numerator to `replayMode=director_cut` keeps this rate
  // bounded to what actually happened in Director Cut sessions.
  const directorCutMilestones: RateMetric[] = WATCH_MILESTONES.map(
    ({ name, label }) =>
      rateMetric({
        id: `director_cut_${name}`,
        label: `Director Cut: ${label}`,
        numerator: mergedDimensionCounts(file, name, "replayMode").director_cut ?? 0,
        denominator: directorCutStarted,
        methodology: `${name} events with context.replayMode="director_cut" ÷ director_cut_started events, all-time. Filtered by mode so a Full Replay viewer's milestone never inflates this rate past 100%.`,
      }),
  );
  // Full Replay has no equivalent "started" event to divide by (there is
  // no director_cut_started-shaped signal for "began watching without
  // Director Cut"), so these are reported as raw counts — per the
  // overinterpretation rule, a rate with a fabricated denominator would be
  // worse than an honest count.
  const fullReplayMilestones: CountMetric[] = WATCH_MILESTONES.map(
    ({ name, label }) =>
      countMetric(
        `full_replay_${name}`,
        `Full Replay: ${label}`,
        mergedDimensionCounts(file, name, "replayMode").full_replay ?? 0,
        `${name} events with context.replayMode="full_replay", all-time raw count — no "started" baseline event exists for Full Replay viewing to divide by.`,
      ),
  );

  // Grouped by matchId (not eventSlug — director_cut_started never carries
  // an eventSlug, so that grouping was structurally always empty). Raw
  // match ids here; `applyMatchLabels` resolves them to a human label at
  // report-serve time (read-model lookup), falling back to the raw id
  // when no label is available.
  const mostWatchedEvents = rankingMetric(
    "most_watched_events",
    "Most-watched matches",
    mergedDimensionCounts(file, "director_cut_started", "matchId"),
    "director_cut_started events grouped by match id, ranked descending, all-time. Labeled via a read-model lookup at report-serve time where available, otherwise the raw match id.",
  );

  const agentBuilderProfileOpens =
    totalEventCount(file, "agent_profile_opened_from_match") +
    totalEventCount(file, "builder_profile_opened");
  const agentBuilderProfileCtr = rateMetric({
    id: "agent_builder_profile_ctr",
    label: "Agent/Builder profile click-through",
    numerator: agentBuilderProfileOpens,
    denominator: directorCutStarted,
    methodology:
      "(agent_profile_opened_from_match + builder_profile_opened) ÷ director_cut_started, all-time.",
  });

  // `returning_*_visitor` is emitted client-side at most ONCE per visitor
  // id per UTC day (see `VisitorId.ts`'s `shouldEmitReturningVisitorToday`)
  // — same-session/same-day navigation can never inflate this numerator,
  // so it genuinely counts distinct RETURNING-VISITOR-DAYS, not page
  // loads. This is still not a strict "came back N days later" cohort
  // metric (that would require per-visitor last-seen retention, which
  // this store deliberately never keeps — see AnalyticsAggregateStore.ts's
  // doc), so the label/methodology says exactly what it measures: the
  // share of page views in the window attributable to an
  // already-established visitor identity.
  const returning7d =
    trailingEventCount(file, "returning_anonymous_visitor", 7, now) +
    trailingEventCount(file, "returning_authenticated_visitor", 7, now);
  const pageViews7d = trailingEventCount(file, "page_viewed", 7, now);
  const sevenDayReturnRate = rateMetric({
    id: "returning_visitor_day_share_7d",
    label: "Returning-visitor-day share (trailing 7 days)",
    numerator: returning7d,
    denominator: pageViews7d,
    methodology:
      '(returning_anonymous_visitor + returning_authenticated_visitor, each capped at ONE emission per visitor id per UTC day) ÷ page_viewed, trailing 7 UTC days. Measures the share of page views attributable to an already-established visitor identity — same-day/same-session navigation never inflates it. NOT a strict "came back N days later" cohort return rate (this store never retains per-visitor history to compute one).',
  });

  const builderFunnel: FunnelStageMetric = {
    id: "builder_funnel",
    label: "Build flow funnel",
    stages: [
      { stage: "build_flow_started", count: totalEventCount(file, "build_flow_started") },
      {
        stage: "build_step_reached (final step)",
        count: mergedDimensionCounts(file, "build_step_reached", "step")["7"] ?? 0,
      },
      {
        stage: "registration_draft_submitted",
        count: totalEventCount(file, "registration_draft_submitted"),
      },
    ],
    status: totalEventCount(file, "build_flow_started") === 0 ? "not_yet_instrumented" : "measured",
    methodology:
      "Raw counts per stage, all-time: flow started, reached the final (7th) build step, draft submitted. Season Zero traffic is expected to be small — report raw counts, not conversion percentages, per the threshold doc's overinterpretation rule.",
  };

  const claimsAndReleases: CountMetric[] = [
    countMetric("claim_started", "Claims started", totalEventCount(file, "claim_started"), "claim_started events, all-time."),
    countMetric(
      "claim_verified",
      "Claims verified",
      totalEventCount(file, "claim_verified"),
      "claim_verified events, all-time.",
    ),
    countMetric(
      "version_release_created",
      "Version releases created",
      totalEventCount(file, "version_release_created"),
      "version_release_created events, all-time.",
    ),
    countMetric(
      "version_observed",
      "Version releases observed by a visitor",
      totalEventCount(file, "version_observed"),
      "version_observed events, all-time.",
    ),
  ];

  const failuresByRoute = routeBreakdownMetric(
    "replay_load_failures_by_route",
    "Replay load failures by route",
    mergedRouteCounts(file, "replay_load_failed"),
    "replay_load_failed events grouped by normalized route template, all-time.",
  );
  const failureReasons = rankingMetric(
    "replay_load_failure_reasons",
    "Replay load failure reasons",
    mergedDimensionCounts(file, "replay_load_failed", "reason"),
    "replay_load_failed events grouped by bounded reason code, ranked descending, all-time.",
  );

  return {
    generatedAt: now.toISOString(),
    homepageToWatchCtr: rateMetric({
      id: "homepage_to_watch_ctr",
      label: "Homepage → watch CTR",
      numerator: homepageCtaClicks,
      denominator: homepagePageViews,
      methodology: "event_cta_clicked ÷ page_viewed, both on route \"/\", all-time.",
    }),
    replayLoadSuccessRate: rateMetric({
      id: "replay_load_success_rate",
      label: "Replay load success rate",
      numerator: replaySucceeded,
      denominator: replayStarted,
      methodology: "replay_load_succeeded ÷ replay_load_started, all-time.",
    }),
    directorCutMilestones,
    fullReplayMilestones,
    mostWatchedEvents,
    agentBuilderProfileCtr,
    sevenDayReturnRate,
    builderFunnel,
    claimsAndReleases,
    failuresByRoute,
    failureReasons,
  };
}

/**
 * Resolves a `RankingMetric`'s raw keys (e.g. match ids) to human labels at
 * report-serve time — kept OUT of `buildAnalyticsReport` (which stays pure
 * and I/O-free) so the read-model lookup this needs lives entirely in the
 * caller (the HTTP route), not baked into the aggregate math this module
 * tests in isolation. `resolveLabel` returning `null` (lookup miss, no
 * read-model available, anything) falls back to the raw key — every ranked
 * item stays labeled with SOMETHING, never blank.
 */
export function applyMatchLabels(
  ranking: RankingMetric,
  resolveLabel: (key: string) => string | null,
): RankingMetric {
  return {
    ...ranking,
    items: ranking.items.map((item) => ({
      key: resolveLabel(item.key) ?? item.key,
      count: item.count,
    })),
  };
}

/** True once at least one of the catalog's events has ever been recorded — lets the report shell distinguish "collector idle" from "collector never received a single event." */
export function hasAnyAnalyticsData(file: AnalyticsAggregateFile, names: readonly AnalyticsEventName[]): boolean {
  return totalAll(file, names) > 0;
}
