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
  server-side session table, no IP matching. The `returning_*_visitor`
  EVENT itself is additionally gated to at most ONE emission per visitor
  id per UTC day (`shouldEmitReturningVisitorToday`, a small
  `localStorage`-keyed day-marker KEYED BY THE VISITOR ID ITSELF — not one
  shared global key, so a mid-day id rotation or a shared machine handing
  the same browser storage to a second visitor can never wrongly suppress
  or wrongly permit an emission for either id) — without this gate at
  all, a visitor id that already existed is "returning" on every page
  load after the first within a single browsing session, which would
  drive the report's return-rate metric toward "pages per session" rather
  than any real day-over-day signal. See "Report metrics" below for
  exactly what the resulting metric measures.
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
  (`director_cut_started` on default-on mount and on explicit toggle-on,
  carrying both `matchId` and `replayMode`; `timeline_jump` on every
  War-Room/timeline jump; `watched_30s`/`watched_2m`/`watched_50pct`/
  `completed` — each carrying `replayMode` ("director_cut" or
  "full_replay", whichever mode the viewer was actually in) since BOTH
  modes emit the SAME event names and the report divides them apart by
  this dimension (see "Report metrics" below). `watched_30s`/`watched_2m`
  fire from ACCUMULATED ACTIVE PLAYBACK seconds — each consecutive frame's
  real delta, capped at ~2s so a pause/buffer/stall gap can never
  masquerade as watched time, with accumulation halted entirely while
  `document.hidden` (a backgrounded tab contributes zero) — never
  wall-clock `Date.now() - firstFrameAt`, which would have inflated the
  retention funnel for anyone who paused or backgrounded the tab.
  `watched_50pct`/`completed` fire from turn progress against the match's
  own finish turn (unaffected by the above fix — always correct). All
  four are one-shot per view, hooked onto the existing
  `ai-league-replay-frame` event rather than a new per-tick loop),
  `ReplayPremiereArchiveView.ts` (`switched_to_full_replay` on the
  archived-premiere "Watch Full Replay" button).
- **Directories/profiles**: `BuildersDirectoryPage.ts`
  (`builder_profile_opened` on each real claimed builder's `/builder/:slug`
  link).
- **Server-side write paths**: `identity-claims.ts`'s `approve` subcommand
  (`claim_verified`), `PlatformBuilderVersionHttp.ts`'s version-release
  route (`version_release_created`), `identity-releases.ts`'s `reconcile`
  subcommand (`version_observed` per newly-observed release),
  `PlatformAccountHttp.ts`'s `GET /api/account` bootstrap route
  (`returning_authenticated_visitor`, see below).

### `returning_authenticated_visitor` semantics

Emitted server-side, not client-side: the platform account cookie
(`PlatformAccountSecurity`) is HttpOnly, so the client genuinely has no
cheap way to know "is this visitor already established" — but the SERVER
does, for free, on every `GET /api/account` call.

**Requires BOTH signals, not just one.** `bootstrapRead` returning
`setCookie: null` means it found an ALREADY-ESTABLISHED account cookie
rather than minting a fresh one — but that alone is NOT "authenticated":
every platform visitor, signed in or not, gets an auto-minted GUEST
account cookie on first touch, so a plain returning GUEST also satisfies
`setCookie: null` on their second visit. Emitting on that signal alone
double-counted the SAME visit against the report's return metric — once
here (`returning_authenticated_visitor`, because the guest account cookie
already existed), once client-side (`returning_anonymous_visitor`,
because the localStorage visitor id already existed too) — which could
push `sevenDayReturnRate` over 100% on traffic that was entirely
anonymous. The fix: this event now requires an already-established cookie
**AND** a genuinely GitHub-linked identity (`githubStatus.login !== null`,
resolved via `identityLinkStore.getStatus` before the emission check
runs) — "carries an established, GitHub-linked platform identity", not
merely "has ever loaded a page here before".

This is an **authenticated visit-DAY** count, not strict per-session
counting. Deduped to at most one emission per `accountId` per UTC day via
a bounded, in-memory, day-keyed set inside `PlatformAccountHttp.ts`
(best-effort: a process restart resets it, matching the "raw counts,
don't overinterpret" posture the whole report already takes).

**Reported separately from the anonymous share, never blended.** Because
every visitor already gets a guest cookie, a signed-in return and an
anonymous return can never be safely summed into one numerator without
risking exactly the double-count above resurfacing in some other form —
so `returningAuthenticatedVisitors` is its own raw-count metric (see the
table below), not folded into `sevenDayReturnRate`.

**Known, honest gaps** (the report shows `not_yet_instrumented` for these
until a real feature/signal exists to hook, never a fabricated number):

- `follow_bookmark` — **no follow/bookmark feature exists in this
  codebase at all** (verified by grep across `src/client` — no button, no
  localStorage key, nothing). The product feature itself is unshipped;
  this is not an instrumentation gap. The event name stays reserved in
  the catalog for whenever a real follow/bookmark control ships — wire it
  then, never before.
- `builder_profile_opened` from `AgentProfilePage.ts` — that page's
  builder line (`renderBuilderLine`) renders `builderDisplayName` as
  **plain text**, not a link; there is no clickable builder-profile
  affordance there to instrument. `BuildersDirectoryPage.ts`'s real
  `/builder/:slug` link IS wired (above). Wiring `AgentProfilePage` would
  require adding a link that doesn't exist today — a product/design
  decision outside this pass's scope, not an oversight.

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
| Director Cut 30s/2m/50%/completion | `watched_30s`/`watched_2m`/`watched_50pct`/`completed` WITH `context.replayMode="director_cut"` ÷ `director_cut_started` | all-time |
| Full Replay 30s/2m/50%/completion | `watched_30s`/`watched_2m`/`watched_50pct`/`completed` WITH `context.replayMode="full_replay"` — raw counts, no rate (no "started" baseline event exists for Full Replay) | all-time |
| Most-watched matches | `director_cut_started` grouped by `matchId`, ranked descending, labeled via a read-model lookup at report-serve time (falls back to the raw match id) | all-time |
| Agent/Builder profile CTR | (`agent_profile_opened_from_match` + `builder_profile_opened`) ÷ `director_cut_started` | all-time |
| Returning-visitor-day share (anonymous) | `returning_anonymous_visitor` (capped at ONE emission per visitor id per UTC day) ÷ `page_viewed` — the share of page views from an already-established ANONYMOUS visitor identity. Deliberately excludes `returning_authenticated_visitor`: every visitor (signed in or not) gets an auto-minted guest account cookie, so blending the two would double-count the same visit | trailing 7 UTC days |
| Returning authenticated visits | raw count of `returning_authenticated_visitor` (emitted server-side ONLY for a genuinely GitHub-linked account, never a plain returning guest) — NOT divided by `page_viewed` and NOT added into the anonymous share above, to avoid reintroducing the same double-count | trailing 7 UTC days, raw count |
| Seven-day cohort return rate | **NOT IMPLEMENTED** — hardcoded `not_yet_instrumented`. A true cohort ("of visitors first seen on day N, the share seen again within 7 days") needs durable per-visitor last-seen retention, which this store deliberately never keeps (`AnalyticsAggregateStore.ts`'s "no visitor id is ever written to this file" contract; the bounded 300-key/day dimension cap is sized for route/event/agent dimensions, not one slot per unique visitor). The day-share metric above is the closest available honest proxy and is never silently substituted here | n/a |
| Build flow funnel | raw stage counts: `build_flow_started`, `build_step_reached` at the final (7th) step, `registration_draft_submitted` | all-time, raw counts (see below) |
| Claims and version releases | raw counts of `claim_started`, `claim_verified`, `version_release_created`, `version_observed` | all-time |
| Failures by route | `replay_load_failed` grouped by normalized route template | all-time |
| Failure reasons | `replay_load_failed` grouped by bounded `reason` code | all-time |

**Why the Director Cut rates are filtered by `replayMode`**: both Director
Cut and Full Replay viewers emit the identical `watched_30s`/`watched_2m`/
`watched_50pct`/`completed` event names — only the `replayMode` context
field distinguishes which mode a given milestone happened in. Dividing the
TOTAL across both modes by `director_cut_started` could report over 100%
whenever Full Replay viewers also crossed a milestone; filtering each
numerator to `context.replayMode="director_cut"` keeps the rate bounded to
what actually happened in Director Cut sessions. Full Replay's own
milestone counts are reported separately, as raw counts, since there is no
"started watching without Director Cut" event to divide by.

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
- measure seven-day return (the returning-visitor-day share proxy — see
  "Report metrics" above; the true cohort rate is honestly
  `not_yet_instrumented`) rather than declaring success from registrations
  alone.

## The overinterpretation rule

**If traffic is too small for a meaningful percentage, report raw counts
and do not overinterpret them.** This is why `MIN_SAMPLE_FOR_RATE` exists,
why the builder funnel is reported as raw stage counts rather than a
conversion percentage (Season Zero's expected volume there is small by
design), and why every rate metric in the report explicitly labels itself
`insufficient_traffic` instead of rendering a precise-looking percentage
off a handful of events. A single-digit numerator is a data point, not a
trend.
