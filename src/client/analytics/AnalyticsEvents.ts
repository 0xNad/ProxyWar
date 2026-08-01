/**
 * Plain-TypeScript mirror of `src/server/analytics/AnalyticsEventSchema.ts`.
 * No zod here on purpose: `AnalyticsClient.ts` must stay tiny and
 * dependency-free since it's meant to be imported by every public page,
 * and validation of what actually gets stored belongs to the server (which
 * silently drops anything malformed — see that module's ingest doc). Keep
 * this list in sync by hand with the server catalog whenever an event name
 * changes; a mismatch fails closed (the server drops the unknown name),
 * never open.
 */

export const ANALYTICS_SCHEMA_VERSION = 1 as const;

export const ANALYTICS_EVENT_NAMES = [
  "page_viewed",
  "featured_event_impression",
  "event_cta_clicked",
  "replay_load_started",
  "replay_load_succeeded",
  "replay_load_failed",
  "director_cut_started",
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

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

/** Same bounded, PII-free field set as the server's `AnalyticsEventContextSchema` — every field optional, every event name uses whichever subset applies. */
export interface AnalyticsEventContext {
  eventSlug?: string;
  matchId?: string;
  agentSlug?: string;
  builderSlug?: string;
  claimId?: string;
  versionLabel?: string;
  replayMode?: "director_cut" | "full_replay";
  step?: number;
  reason?: string;
}

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  occurredAt: string;
  route: string;
  context?: AnalyticsEventContext;
}

export interface AnalyticsBatch {
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION;
  visitorId: string;
  events: AnalyticsEvent[];
}
