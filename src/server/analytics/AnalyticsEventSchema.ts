import { z } from "zod";

/**
 * First-party product analytics event catalog — Season Zero Phase 7 ("the
 * product hypothesis" per PROXYWAR_SEASON_ZERO_ACTIVATION_PROMPT.md). This
 * is the server-side source of truth: batched, schema-validated, and the
 * only place that decides whether an event is well-formed. The client
 * emitter (`src/client/analytics/AnalyticsEvents.ts`) is deliberately a
 * plain-TypeScript mirror of the event-name union with NO zod dependency —
 * see that file's doc for why — so keep the two in sync by hand whenever an
 * event name is added or removed here.
 *
 * Privacy posture (see also `src/client/analytics/VisitorId.ts`):
 *  - No PII. Every field below is a bounded slug/id/enum/number — never a
 *    free-text field that could carry a name, email, or message.
 *  - No IP retention. The route handler never persists the requester's IP;
 *    only the batched event payload below reaches storage.
 *  - `visitorId` is a client-generated, non-fingerprinting random id that
 *    the client itself rotates every 30 days (see VisitorId.ts) — the
 *    server treats it as an opaque bounded string, never derives identity
 *    from it, and never joins it against any other user-identifying store.
 *  - Aggregation is silent and additive: nothing in this module ever gates,
 *    delays, or changes what a visitor sees (same invariant as the Stage 7
 *    `BuildFunnelCounters` precedent this generalizes).
 */

/** Bump when the wire shape changes in a way old stored aggregates can't absorb. */
export const ANALYTICS_SCHEMA_VERSION = 1 as const;

export const ANALYTICS_EVENT_NAMES = [
  "page_viewed",
  "featured_event_impression",
  "event_cta_clicked",
  "replay_load_started",
  "replay_load_succeeded",
  "replay_load_failed",
  "watched_30s",
  "watched_2m",
  "watched_50pct",
  "completed",
  "switched_to_full_replay",
  "decisive_moment_opened",
  "timeline_jump",
  "agent_profile_opened_from_match",
  "builder_profile_opened",
  "follow_bookmark",
  "returning_anonymous_visitor",
  "returning_authenticated_visitor",
  "build_flow_started",
  "build_step_reached",
  "registration_draft_submitted",
  "claim_started",
  "claim_verified",
  "version_release_created",
  "version_observed",
] as const;

export const AnalyticsEventNameSchema = z.enum(ANALYTICS_EVENT_NAMES);
export type AnalyticsEventName = z.infer<typeof AnalyticsEventNameSchema>;

/** A bounded slug: lowercase-ish identifiers used across the read model (event/agent/builder slugs, version labels). */
const BoundedSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);

/** A bounded opaque id (match/run ids, claim ids) — slightly wider charset than a slug, still capped. */
const BoundedIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/);

/** A bounded machine reason code, never a free-text error message. */
const BoundedReasonSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/**
 * Every field here is optional and independently bounded — this is the
 * "route/context slice (bounded fields only)" the phase brief calls for.
 * One flat shape shared by all event names (rather than a per-event union)
 * keeps the wire format, storage, and report code simple; unused fields for
 * a given event name are just omitted by the caller.
 */
export const AnalyticsEventContextSchema = z
  .object({
    eventSlug: BoundedSlugSchema.optional(),
    matchId: BoundedIdSchema.optional(),
    agentSlug: BoundedSlugSchema.optional(),
    builderSlug: BoundedSlugSchema.optional(),
    claimId: BoundedIdSchema.optional(),
    versionLabel: BoundedSlugSchema.optional(),
    step: z.number().int().min(1).max(7).optional(),
    reason: BoundedReasonSchema.optional(),
  })
  .strict();
export type AnalyticsEventContext = z.infer<typeof AnalyticsEventContextSchema>;

export const AnalyticsEventSchema = z
  .object({
    name: AnalyticsEventNameSchema,
    /** Client wall-clock at emission time, ISO-8601. Never used to bucket storage (see AnalyticsAggregateStore); server receive time is authoritative for that. Kept only for the bounded recent-events ring. */
    occurredAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
    /** Raw pathname; the server normalizes this into a bounded route template before it's ever persisted (see `normalizeAnalyticsRoute`). */
    route: z.string().min(1).max(200),
    context: AnalyticsEventContextSchema.optional(),
  })
  .strict();
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

const MAX_EVENTS_PER_BATCH = 25;

export const AnalyticsBatchSchema = z
  .object({
    schemaVersion: z.literal(ANALYTICS_SCHEMA_VERSION),
    /** Client-generated bounded anonymous id — see VisitorId.ts. Opaque to the server. */
    visitorId: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]{8,64}$/),
    events: z.array(AnalyticsEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
  })
  .strict();
export type AnalyticsBatch = z.infer<typeof AnalyticsBatchSchema>;

/**
 * Collapses a raw pathname into a small, bounded set of route templates so
 * per-route aggregates can never grow unbounded with per-match/per-agent
 * cardinality. Segments that look like an id (long alphanumeric/dash/
 * underscore tokens, or purely numeric) become `:id`; only the first three
 * segments are kept.
 */
export function normalizeAnalyticsRoute(rawPath: string): string {
  const pathname = (() => {
    try {
      // Tolerate a full URL or a bare pathname.
      return rawPath.startsWith("http")
        ? new URL(rawPath).pathname
        : rawPath.split("?")[0].split("#")[0];
    } catch {
      return "/";
    }
  })();
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  // The first segment is always the route's literal "family" (`league`,
  // `match`, `agent`, `build`, …) — a small, known, finite set — never an
  // id. Only later segments are candidate ids, and only when they look
  // opaque: containing a digit (run/match ids, round numbers) or long
  // enough that they're unlikely to be a hand-written route word.
  const idLike = /[0-9]/;
  const normalized = segments.slice(0, 3).map((segment, index) => {
    if (index === 0) return segment.toLowerCase();
    return idLike.test(segment) || segment.length >= 16
      ? ":id"
      : segment.toLowerCase();
  });
  const result = `/${normalized.join("/")}`;
  return result.length > 80
    ? result.slice(0, 80)
    : result === "/"
      ? "/"
      : result;
}
