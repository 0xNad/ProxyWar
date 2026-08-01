# Season Zero product analytics — methodology and thresholds

Season Zero Phase 7 ("Instrument the product hypothesis") ships first-party,
privacy-conscious product analytics: a bounded event catalog, a batched
ingest endpoint, durable aggregates, and an invite-gated operator report at
`/analytics-report` (JSON at `/api/analytics-report`). This document is the
methodology reference the report itself links back to.

## What's collected, and what isn't

- **Event catalog**: `src/server/analytics/AnalyticsEventSchema.ts` is the
  source of truth — `page_viewed`, `featured_event_impression`,
  `event_cta_clicked`, `replay_load_started/succeeded/failed`,
  `director_cut_started`, `watched_30s/2m/50pct`, `completed`,
  `switched_to_full_replay`, `decisive_moment_opened`, `timeline_jump`,
  `agent_profile_opened_from_match`, `builder_profile_opened`,
  `follow_bookmark`, `returning_anonymous_visitor`,
  `returning_authenticated_visitor`, `build_flow_started`,
  `build_step_reached`, `registration_draft_submitted`, `claim_started`,
  `claim_verified`, `version_release_created`, `version_observed`.
- **No PII.** Every event carries a route (server-normalized into a small
  set of templates, e.g. `/match/:id`) and a bounded `context` object —
  slugs, ids, a machine reason code, a 1–7 build step. Nothing here is a
  free-text field, and nothing carries an IP address, user agent, or name
  into storage.
- **Anonymous identity, not a fingerprint.** The client (`VisitorId.ts`)
  generates a random id, stores it only in `localStorage`, and rotates it
  every 30 days — destroying the old value, not renewing it. That makes
  correlating one visitor's behavior across more than ~30 days structurally
  impossible from this id alone. "Returning visitor" is derived from
  nothing but "this id already existed when the page loaded" — no
  server-side session table, no IP matching.
- **Storage is aggregate, not raw.** `AnalyticsAggregateStore.ts` keeps one
  JSON file: per-UTC-day, per-event-name counts, a bounded `byRoute`
  breakdown, and a bounded `byDimension` breakdown (event/agent/builder
  slug, version label, failure reason, replay mode, build step) — each
  capped at 300 distinct keys per day with overflow folded into a single
  `"__other__"` bucket. Retained 120 days, then pruned. No visitor id is
  ever written to this file. A separate, small, fixed-capacity (200-entry)
  `AnalyticsRecentRing.ts` gives the operator report a live "what's
  happening now" tail — route template + event name + failure reason only,
  never a visitor id.
- **Ingestion never gates or delays the product.** `POST
  /api/analytics/events` is schema-validated, batch-capped (25 events),
  rate-limited per IP and per visitor id, and always answers `204` — an
  invalid or rate-limited batch is silently dropped, never surfaced as an
  error a visitor's experience depends on. It is deliberately reachable in
  `PROXYWAR_LEAGUE_WRAPPER_ONLY=true` mode (the live public deployment's
  actual hardened posture), the same way `/api/build/funnel-event` already
  is — an analytics endpoint that only works in every OTHER mode would
  silently collect nothing in production.

## Instrumentation status

Wired into the product surfaces as of this pass:

- **Public pages** (`PublicApp.ts` central dispatch → `page_viewed` +
  `returning_anonymous_visitor` on every route mount): `LobbyPage`
  (`featured_event_impression` on the hero, `event_cta_clicked` on the
  watch CTA), `WatchPage` (`featured_event_impression` per featured
  programme card, `event_cta_clicked` on the view-match/watch-replay
  links), `MatchDetailPage` (`agent_profile_opened_from_match` on every
  agent link — participant card, winner, placements, decisive-moment
  agents — plus `decisive_moment_opened` on the jump link), `BuildPage`
  (`build_flow_started`/`build_step_reached`/`registration_draft_submitted`
  — supersedes the Stage 7 `BuildFunnelCounters`/`/api/build/funnel-event`
  pair, which stays live server-side only for backward compatibility with
  any stale cached client bundle mid-deploy), `BuilderClaimPage`
  (`claim_started` on a successful submission).
- **Replay surfaces**: `ReplayLoadingScreen.ts`
  (`replay_load_started`/`succeeded`/`failed`, threaded with the match id
  from `Main.ts`'s `openAiLeagueReplay`), `AiLeagueReplayOverlay.ts`
  (`director_cut_started` on default-on mount and on explicit toggle-on;
  `timeline_jump` on every War-Room/timeline jump; `watched_30s`/
  `watched_2m` from wall-clock elapsed time since the first frame,
  `watched_50pct`/`completed` from turn progress against the match's own
  finish turn — all one-shot per view, hooked onto the existing
  `ai-league-replay-frame` event rather than a new per-tick loop),
  `ReplayPremiereArchiveView.ts` (`switched_to_full_replay` on the
  archived-premiere "Watch Full Replay" button).
- **Server-side write paths**: `identity-claims.ts`'s `approve` subcommand
  (`claim_verified`), `PlatformBuilderVersionHttp.ts`'s version-release
  route (`version_release_created`), `identity-releases.ts`'s `reconcile`
  subcommand (`version_observed` per newly-observed release).

**Known, honest gaps** (the report shows `not_yet_instrumented` for these
until a real feature/signal exists to hook, never a fabricated number):

- `follow_bookmark` — no follow/bookmark feature exists yet in the
  directory pages; the event name is reserved for when it ships.
- `builder_profile_opened` — no builder-profile link site was in scope for
  this pass (only agent-profile links from a match were); the event stays
  ready for the next instrumentation pass.
- `returning_authenticated_visitor` — the public pages have no cheap,
  synchronous client-side "is this visitor logged in" signal at mount time
  (the platform account session is an HttpOnly cookie, checked
  server-side only); guessing from the route alone would misclassify an
  anonymous visitor. Every route currently reports `page_viewed` +, when
  applicable, `returning_anonymous_visitor` only.

Every report metric still carries one of three honest states:

- **`not_yet_instrumented`** — the event(s) this metric needs have never
  been recorded at all (all-time count is zero).
- **`insufficient_traffic`** — some data exists, but the denominator is
  below the minimum sample size (`MIN_SAMPLE_FOR_RATE = 20` in
  `AnalyticsReport.ts`). The report shows raw counts, not a percentage.
- **`measured`** — enough traffic exists to report a percentage.

## Report metrics and their methodology

| Metric | Formula | Window |
| --- | --- | --- |
| Homepage → watch CTR | `event_cta_clicked` ÷ `page_viewed`, both on route `/` | all-time |
| Replay load success rate | `replay_load_succeeded` ÷ `replay_load_started` | all-time |
| Director Cut 30s/2m/50%/completion | `watched_30s` / `watched_2m` / `watched_50pct` / `completed` ÷ `director_cut_started` | all-time |
| Most-watched Featured Events | `director_cut_started` grouped by `eventSlug`, ranked descending | all-time |
| Agent/Builder profile CTR | (`agent_profile_opened_from_match` + `builder_profile_opened`) ÷ `director_cut_started` | all-time |
| Seven-day return rate | (`returning_anonymous_visitor` + `returning_authenticated_visitor`) ÷ `page_viewed` | trailing 7 UTC days |
| Build flow funnel | raw stage counts: `build_flow_started`, `build_step_reached` at the final (7th) step, `registration_draft_submitted` | all-time, raw counts (see below) |
| Claims and version releases | raw counts of `claim_started`, `claim_verified`, `version_release_created`, `version_observed` | all-time |
| Failures by route | `replay_load_failed` grouped by normalized route template | all-time |
| Failure reasons | `replay_load_failed` grouped by bounded `reason` code | all-time |

## Season Zero decision thresholds

These are **explicit initial thresholds for this specific effort**, not
universal truths, and not something to hardcode as permanent product law.

**Technical** (evaluated in controlled testing, not live traffic):

- 99%+ replay-load success across supported browsers;
- 100% of public Featured Events have identities, versions, and working
  watch links;
- 100% of revealed Featured Events have Director Cut or an explicit,
  documented Full-Replay-only exception;
- zero critical route dead ends;
- zero public betting surfaces;
- zero lint errors;
- zero critical test TODOs.

**Product** (evaluated only once real traffic exists):

- at least 35% of homepage Featured Event visitors start the Director Cut;
- at least 50% of Director Cut starters reach 30 seconds;
- at least 25% reach 50%;
- at least 10% click an Agent or Builder profile;
- measure seven-day return rather than declaring success from
  registrations alone.

## The overinterpretation rule

**If traffic is too small for a meaningful percentage, report raw counts
and do not overinterpret them.** This is why `MIN_SAMPLE_FOR_RATE` exists,
why the builder funnel is reported as raw stage counts rather than a
conversion percentage (Season Zero's expected volume there is small by
design), and why every rate metric in the report explicitly labels itself
`insufficient_traffic` instead of rendering a precise-looking percentage
off a handful of events. A single-digit numerator is a data point, not a
trend.
