import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { withFileMutex } from "../agents/FileMutex";
import type { AnalyticsEvent, AnalyticsEventName } from "./AnalyticsEventSchema";
import { normalizeAnalyticsRoute } from "./AnalyticsEventSchema";

/**
 * Durable, additive-only aggregates for the product-analytics event stream —
 * generalizes `BuildFunnelCounters.ts`'s pattern (per-UTC-day counters, a
 * single JSON file, serialized read-modify-write via a promise queue,
 * tmp-file + rename for atomic persistence) to the full Phase 7 event
 * catalog.
 *
 * Deliberately NOT a raw per-event log: storing one JSON line per pageview
 * forever is unbounded and re-introduces exactly the "IP/session trail"
 * privacy surface the phase brief asks us to avoid, for no report benefit —
 * every metric in `AnalyticsReport.ts` is a count, a rate, or a small
 * "top N" ranking, all of which are answerable from bucketed sums. What IS
 * kept here beyond a bare count is bounded on every axis:
 *  - one bucket per UTC calendar day, pruned past `RETENTION_DAYS`;
 *  - one row per known event name (fixed-size catalog, see
 *    AnalyticsEventSchema.ts);
 *  - a small per-event `byRoute` map keyed on the *normalized* route
 *    template (`normalizeAnalyticsRoute` collapses ids to `:id`, so
 *    cardinality stays in the dozens, not one entry per match);
 *  - a small per-event `byDimension` map (event/agent/builder slug,
 *    version label, failure reason, replay mode) capped per dimension per
 *    day, with overflow bucketed into a literal `"__other__"` key rather
 *    than growing without bound.
 * No visitor id is ever written to this file.
 */

const RETENTION_DAYS = 120;
const MAX_DIMENSION_KEYS_PER_DAY = 300;

const DimensionBucketSchema = z.record(z.string(), z.number().int().min(0));

const EventAggregateSchema = z
  .object({
    count: z.number().int().min(0),
    byRoute: DimensionBucketSchema,
    byDimension: z.record(z.string(), DimensionBucketSchema),
  })
  .strict();
type EventAggregate = z.infer<typeof EventAggregateSchema>;

const DayAggregateSchema = z
  .object({
    events: z.record(z.string(), EventAggregateSchema),
  })
  .strict();
type DayAggregate = z.infer<typeof DayAggregateSchema>;

const AggregateFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    byDay: z.record(z.string(), DayAggregateSchema),
  })
  .strict();
export type AnalyticsAggregateFile = z.infer<typeof AggregateFileSchema>;

function emptyFile(): AnalyticsAggregateFile {
  return { schemaVersion: 1, byDay: {} };
}

function emptyEventAggregate(): EventAggregate {
  return { count: 0, byRoute: {}, byDimension: {} };
}

function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Dimensions the report can rank/filter by — every other context field is route-scoped only. */
const DIMENSION_CONTEXT_KEYS = [
  "eventSlug",
  "matchId",
  "agentSlug",
  "builderSlug",
  "claimId",
  "versionLabel",
  "reason",
  "replayMode",
  "step",
] as const;

export class AnalyticsAggregateStore {
  private readonly filePath: string;

  constructor(artifactsRootDir: string) {
    this.filePath = path.join(artifactsRootDir, "analytics-aggregates.json");
  }

  /**
   * Fire-and-forget from the ingest route — never throws. Wrapped in
   * `withFileMutex` (the same cross-process file lock
   * `PlatformBuilderClaimStore.ts`/`PlatformVersionReleaseStore.ts` already
   * use) rather than an in-process-only queue: server-side hooks
   * (`claim_verified`, `version_release_created`, `version_observed`) run
   * in short-lived CLI processes separate from the always-running demo
   * server, so a same-process promise chain alone cannot prevent a lost
   * update between two processes racing the same read-modify-write cycle.
   */
  async recordEvents(events: readonly AnalyticsEvent[], now: Date = new Date()): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await withFileMutex(this.filePath, () => this.applyEvents(events, now)).catch(
      () => undefined,
    );
  }

  async readAll(): Promise<AnalyticsAggregateFile> {
    return this.read();
  }

  private async applyEvents(events: readonly AnalyticsEvent[], now: Date): Promise<void> {
    const file = await this.read();
    const dayKey = utcDayKey(now);
    const day: DayAggregate = {
      events: { ...(file.byDay[dayKey]?.events ?? {}) },
    };
    for (const event of events) {
      day.events[event.name] = applyEventToAggregate(
        day.events[event.name] ?? emptyEventAggregate(),
        event,
      );
    }
    file.byDay[dayKey] = day;
    pruneOldDays(file, now);
    await this.write(file);
  }

  private async read(): Promise<AnalyticsAggregateFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = AggregateFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : emptyFile();
    } catch {
      return emptyFile();
    }
  }

  private async write(file: AnalyticsAggregateFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(file, null, 2));
    await fs.rename(tmpPath, this.filePath);
  }
}

function applyEventToAggregate(aggregate: EventAggregate, event: AnalyticsEvent): EventAggregate {
  const next: EventAggregate = {
    count: aggregate.count + 1,
    byRoute: { ...aggregate.byRoute },
    byDimension: { ...aggregate.byDimension },
  };
  const routeKey = normalizeAnalyticsRoute(event.route);
  bumpBounded(next.byRoute, routeKey, MAX_DIMENSION_KEYS_PER_DAY);
  for (const dimensionKey of DIMENSION_CONTEXT_KEYS) {
    const rawValue = event.context?.[dimensionKey];
    if (rawValue === undefined) {
      continue;
    }
    const value = String(rawValue);
    const bucket = { ...(next.byDimension[dimensionKey] ?? {}) };
    bumpBounded(bucket, value, MAX_DIMENSION_KEYS_PER_DAY);
    next.byDimension[dimensionKey] = bucket;
  }
  return next;
}

/** Increments `map[key]` in place, redirecting overflow past `cap` distinct keys into `"__other__"` — the overflow decision must land on the SAME key it was computed for, so this mutates rather than returning a bare count for the caller to (mis)assign. */
function bumpBounded(map: Record<string, number>, key: string, cap: number): void {
  const targetKey = key in map || Object.keys(map).length < cap ? key : "__other__";
  map[targetKey] = (map[targetKey] ?? 0) + 1;
}

function pruneOldDays(file: AnalyticsAggregateFile, now: Date): void {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffKey = utcDayKey(cutoff);
  for (const dayKey of Object.keys(file.byDay)) {
    if (dayKey < cutoffKey) {
      delete file.byDay[dayKey];
    }
  }
}

/** Total observations of `eventName` across every retained day — used to distinguish "not yet instrumented" from "measured, zero traffic". */
export function totalEventCount(file: AnalyticsAggregateFile, eventName: AnalyticsEventName): number {
  let total = 0;
  for (const day of Object.values(file.byDay)) {
    total += day.events[eventName]?.count ?? 0;
  }
  return total;
}

/** Sums `eventName`'s count across days within the trailing `days` window (inclusive of `now`'s UTC day). */
export function trailingEventCount(
  file: AnalyticsAggregateFile,
  eventName: AnalyticsEventName,
  days: number,
  now: Date = new Date(),
): number {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  const cutoffKey = utcDayKey(cutoff);
  let total = 0;
  for (const [dayKey, day] of Object.entries(file.byDay)) {
    if (dayKey < cutoffKey) {
      continue;
    }
    total += day.events[eventName]?.count ?? 0;
  }
  return total;
}

/** Merged `byRoute` map for `eventName` across every retained day — used for the "failures by route" breakdown. */
export function mergedRouteCounts(
  file: AnalyticsAggregateFile,
  eventName: AnalyticsEventName,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const day of Object.values(file.byDay)) {
    const byRoute = day.events[eventName]?.byRoute ?? {};
    for (const [route, count] of Object.entries(byRoute)) {
      merged[route] = (merged[route] ?? 0) + count;
    }
  }
  return merged;
}

/** Merged `byDimension[dimensionKey]` map for `eventName` across every retained day — used for "most-watched events" style rankings. */
export function mergedDimensionCounts(
  file: AnalyticsAggregateFile,
  eventName: AnalyticsEventName,
  dimensionKey: (typeof DIMENSION_CONTEXT_KEYS)[number],
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const day of Object.values(file.byDay)) {
    const bucket = day.events[eventName]?.byDimension[dimensionKey] ?? {};
    for (const [value, count] of Object.entries(bucket)) {
      merged[value] = (merged[value] ?? 0) + count;
    }
  }
  return merged;
}
