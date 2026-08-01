import { ProxyWarRateLimiter } from "../agents/ProxyWarRateLimit";
import type { AnalyticsAggregateStore } from "./AnalyticsAggregateStore";
import { AnalyticsBatchSchema } from "./AnalyticsEventSchema";
import type { AnalyticsRecentRing } from "./AnalyticsRecentRing";

/**
 * Orchestrates one POST /api/analytics/events call: validate, rate-limit
 * per visitor id, persist. Framework-free (no `Request`/`Response`) so it's
 * directly unit-testable; `ai-agent-demo-server.ts`'s route handler is a
 * thin adapter that always answers 204 regardless of the result, exactly
 * like the `/api/build/funnel-event` precedent — analytics ingestion must
 * never surface an error state a real visitor's UX depends on.
 *
 * Two independent defenses against abuse:
 *  - the route handler's own IP-keyed `enforceRateLimit("analytics", ...)`
 *    (registered by the caller, matching every other `/api/*` route);
 *  - this service's visitor-id-keyed limiter below, which bounds how many
 *    batches a single (client-chosen) visitor id can submit per window —
 *    independent of IP, since a shared IP legitimately serves many
 *    visitors and a single visitor id spamming batches from a rotating IP
 *    would otherwise evade the IP limiter entirely.
 */

const DEFAULT_VISITOR_WINDOW_MS = 60_000;
const DEFAULT_VISITOR_BATCH_LIMIT_PER_WINDOW = 30;

export interface AnalyticsIngestResult {
  accepted: number;
  droppedInvalid: boolean;
  rateLimited: boolean;
}

export class AnalyticsIngestService {
  private readonly visitorRateLimiter: ProxyWarRateLimiter;
  private readonly visitorLimitPerWindow: number;

  constructor(
    private readonly aggregateStore: AnalyticsAggregateStore,
    private readonly recentRing: AnalyticsRecentRing,
    options: { visitorLimitPerWindow?: number; visitorWindowMs?: number } = {},
  ) {
    this.visitorRateLimiter = new ProxyWarRateLimiter({
      windowMs: options.visitorWindowMs ?? DEFAULT_VISITOR_WINDOW_MS,
    });
    this.visitorLimitPerWindow =
      options.visitorLimitPerWindow ?? DEFAULT_VISITOR_BATCH_LIMIT_PER_WINDOW;
  }

  /**
   * Resolves once the batch is fully validated, rate-limit-checked, and (if
   * accepted) durably written to both stores. The demo-server route never
   * awaits this — see its own doc — but the returned promise still exists
   * so tests can deterministically observe what landed rather than racing
   * the fire-and-forget write queues.
   */
  async ingest(rawBody: unknown, now: Date = new Date()): Promise<AnalyticsIngestResult> {
    const parsed = AnalyticsBatchSchema.safeParse(rawBody);
    if (!parsed.success) {
      return { accepted: 0, droppedInvalid: true, rateLimited: false };
    }
    const batch = parsed.data;
    const rateLimitResult = this.visitorRateLimiter.consume({
      scope: "analytics-visitor",
      key: batch.visitorId,
      limit: this.visitorLimitPerWindow,
      now: now.getTime(),
    });
    if (!rateLimitResult.allowed) {
      return { accepted: 0, droppedInvalid: false, rateLimited: true };
    }
    await Promise.all([
      this.aggregateStore.recordEvents(batch.events, now),
      this.recentRing.pushEvents(batch.events, now),
    ]);
    return { accepted: batch.events.length, droppedInvalid: false, rateLimited: false };
  }
}
