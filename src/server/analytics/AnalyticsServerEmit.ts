import { AnalyticsAggregateStore } from "./AnalyticsAggregateStore";
import type { AnalyticsEventContext, AnalyticsEventName } from "./AnalyticsEventSchema";
import { AnalyticsRecentRing } from "./AnalyticsRecentRing";

/**
 * Emits one analytics event from a SERVER-side write path — `claim_verified`
 * (`identity:claims approve`), `version_release_created` (the version-
 * releases HTTP route), `version_observed` (`identity:releases reconcile`).
 * These are operator/system actions, not a visitor's browser, so there is
 * no `AnalyticsClient.ts` batching/visitor-id involved: this writes
 * straight to the same durable stores the ingest route uses, using a fixed
 * `route` convention (`/server/<action>`) that keeps server-originated
 * events visibly distinct from real visitor routes in the report's byRoute
 * breakdowns.
 *
 * `artifactsRootDir` is passed explicitly rather than resolved from a
 * module-level constant — the callers here are CLI scripts and an HTTP
 * route, each already threading their own resolved artifacts root through
 * (matching `IdentityRegistry.ts`'s documented staleness trap: a
 * module-load-time constant baked in before a caller sets an env var is
 * the wrong shape for a function every caller might invoke with a
 * different root, e.g. under test).
 *
 * Never throws — a failed emit must never surface to the operator action
 * it's attached to (same invariant as the client emitter and the ingest
 * route). `AnalyticsAggregateStore`/`AnalyticsRecentRing` construction is
 * cheap (just a resolved file path); no benefit to caching an instance
 * across these low-frequency, short-lived call sites.
 */
export async function emitServerAnalyticsEvent(
  artifactsRootDir: string,
  name: AnalyticsEventName,
  context?: AnalyticsEventContext,
  now: Date = new Date(),
): Promise<void> {
  try {
    const event = {
      name,
      occurredAt: now.toISOString(),
      route: `/server/${name}`,
      ...(context !== undefined ? { context } : {}),
    };
    const aggregateStore = new AnalyticsAggregateStore(artifactsRootDir);
    const recentRing = new AnalyticsRecentRing(artifactsRootDir);
    await Promise.all([
      aggregateStore.recordEvents([event], now),
      recentRing.pushEvents([event], now),
    ]);
  } catch {
    // Analytics must never affect the outcome of the operator action it's
    // attached to.
  }
}
