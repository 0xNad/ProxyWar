# Proxy War — Public App Architecture

Date: 2026-07-31. Describes what exists on `claude/product-overhaul` at the
close of the public product overhaul. See `PROXYWAR_PRODUCT_NORTH_STAR.md`
for the product goal this serves, `PROXYWAR_IDENTITY_MODEL.md` for the
identity registry in depth, and `PROXYWAR_PREMIERE_RUNBOOK.md` for Premiere
operations.

## One-screen summary

```text
Softmax Coworld (authoritative league state)
        |
        v
CoworldLeagueSiteWriter (regenerates every ~30s)
        |
        +--> static league mirror (league/index.html, data.json,
        |     read-model.json) — the resilience fallback, survives
        |     an SPA outage
        |
        +--> ProxyWarPublicReadModel — typed, Zod-validated, privacy-
              audited read model the SPA fetches
        |
        v
public.html + PublicApp.ts (Lit SPA, Stage 2-7 pages)  <-- separate
        |                                                   Vite entry
        v                                                   from the
narrow /api/* read routes (featured-matches, players,        game/replay
build) + the platform origin (accounts, GitHub OAuth)         shell
```

Two Vite entries exist side by side and are never mixed:
`public.html` → `src/client/PublicApp.ts` for every page under
`src/client/publicapp/**` (the product overhaul's own pages), and
`index.html` → `src/client/Main.ts` for the game/replay/premiere shell
(matchmaking, the Pixi.js renderer, `AiLeagueReplayOverlay.ts`,
`ReplayPremiereOverlay.ts`). This split is why the public pages never load
the game bundle — see "No game bundle on public routes" below.

## Route map

| Route                      | Shell                                                                 | Notes                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/`                        | `public.html` (wrapper-only) or platform root HTML (platform-enabled) | See "Root route branching" below.                                                                                              |
| `/league`                  | static mirror `league/index.html`                                     | Resilience fallback; regenerated every ~30s independent of the SPA.                                                            |
| `/watch`                   | `public.html`                                                         | Event lobby / upcoming+active Premiere hub.                                                                                    |
| `/agents`                  | `public.html`                                                         | Agents directory.                                                                                                              |
| `/agent/:slug`             | `public.html`                                                         | Agent profile (identity + stats + Analysis tab).                                                                               |
| `/builders`                | `public.html`                                                         | Builders directory.                                                                                                            |
| `/builder/:slug`           | `public.html`                                                         | Builder profile.                                                                                                               |
| `/match/:matchId`          | `public.html`                                                         | Canonical `FeaturedMatch` detail page.                                                                                         |
| `/about`                   | `public.html`                                                         | Static about page.                                                                                                             |
| `/build`                   | `public.html`                                                         | Guided Builder registration flow (Stage 7).                                                                                    |
| `/premiere/:premiereId`    | `index.html` (game shell)                                             | Sealed Premiere viewer — not a `public.html` page; it needs the full replay/canvas runtime.                                    |
| `/ai-league-replay/:runID` | `index.html` (game shell)                                             | Full Replay viewer.                                                                                                            |
| `/openfront-replay/:runID` | redirect                                                              | Legacy alias — 301/302s to the canonical `/ai-league-replay/:runID` route, kept for old external links.                        |
| `/account`                 | platform origin only                                                  | 404/soft-redirect on a league-only deployment when the platform origin isn't configured; see `PROXYWAR_PLATFORM_ORIGIN` below. |
| `/player/:name`            | `index.html` shell, own page component                                | Platform-side player profile; identical stats to the Agent side (spec requirement — see `PROXYWAR_IDENTITY_MODEL.md`).         |

`sendPublicAppShellPage()` (`src/scripts/ai-agent-demo-server.ts`) is the one
function every `public.html` route above calls — it renders the shared app
shell with a per-request CSP nonce (`pageContentSecurityPolicyWithNonce`,
`leagueContentSecurityPolicy()`), so there is exactly one place that can
regress the public pages' CSP, not nine.

### Root route branching

`GET /` branches on two independent flags, both read once at server start:

- `leagueWrapperOnly && !platformEnabled` → serves the `public.html` event
  lobby (this is the showcase/league-only deployment shape — no accounts on
  this origin at all).
- `platformEnabled` → serves a server-rendered platform root HTML
  (`renderPlatformRootHtml`) instead — this is the apex/platform origin
  shape, where accounts and player profiles live.

A single process is never both at once in the sanctioned production
deployment — see "Security boundaries" below.

## The read model

`GET /ai-league-runs/league/read-model.json` is the one document every
`public.html` page fetches (client-side Zod validation:
`src/client/publicapp/ReadModelSchema.ts`, deliberately independent of the
server's own `src/server/ProxyWarPublicReadModel.ts` type, so a server bug
that emits a malformed field fails a Zod parse in the browser instead of
silently rendering garbage). Top-level shape: `agents[]` (`PublicAgent`),
`matches[]` (`PublicMatch`), `premieres.{live,upcoming}`, `stale` +
`lastGoodSyncAt` (see "Stale feeds" below), plus builder/version rollups.

`PublicAgent.registered` is load-bearing — every consumer must check it
before trusting `slug`/`emblemSvg`/`shortCode`; an unregistered live
participant gets a row with `displayName` falling back to the raw Coworld
`playerName` and every identity field null, never fabricated. See
`PROXYWAR_IDENTITY_MODEL.md` for the full schema and the champion-vs-rating
`provenance`/`activeVersion` fields.

### Stale feeds

The read model publishes atomically with last-good snapshots: if a
regeneration cycle fails (Coworld unreachable, a malformed intermediate
artifact), the previously-published read model keeps serving with
`stale: true` and `lastGoodSyncAt` set to the last successful publish time,
never a partial or empty document. `LobbyPage.ts` and the league mirror both
render a stale banner from this flag.

### ETag / caching (verified, not changed — spec Stage 8 item 4)

`/ai-league-runs/**` (which includes `read-model.json` and `data.json`) is
served via `express.static` in the sanctioned `PROXYWAR_LEAGUE_WRAPPER_ONLY`
deployment shape (`ai-agent-demo-server.ts`, the `else` branch around line
2276-2298). `express.static`'s default behavior already emits a weak `ETag`

- `Last-Modified`, and a matching `If-None-Match` already gets a real `304`
  — confirmed live against a running instance. The narrow `/api/*` routes
  (`/api/featured-matches/:matchId`, `/api/premieres/:premiereId/featured-match`,
  `/api/players/:name`, `/api/premieres/account`) deliberately set
  `Cache-Control: no-store` instead — these carry premiere/spoiler-sensitive or
  account-scoped state that must never be served stale even for one
  conditional-GET round trip, so `no-store` there is correct, not an oversight.

## Security boundaries

### Wrapper-only posture

`PROXYWAR_LEAGUE_WRAPPER_ONLY=true` is the actual production posture for the
league-origin (`beta.proxywar.xyz`-shaped) deployment. In this mode:

- Private/operator routes never render real content anonymously:
  `/tester-dashboard`, `/api/tester-dashboard`, `/admin`, `/api/status`
  (redirect/40x/404, verified live — see `tests/server/security/PublicSurfaceSecurity.test.ts`).
- Every mutating or operator-billed route 404s: `POST /api/jobs`,
  `/api/quick-start`, `/api/lobby/join`, `/api/agent-relay/sessions`,
  `/api/nations`, `/api/agent-cards/import[-and-run]`,
  `/api/external-agents/check`, `DELETE /api/nations/:id`.
- `decisions.jsonl` and `visual-report.html` under any run directory 404 —
  they never leave the origin (Stage 3 fix, regression-pinned).
- No betting UI or route is served — the wagering subsystem is a separate
  gate, below.

### Wagering gate

`PROXYWAR_WAGERING_ENABLED`'s absence (the default) is the entire
enforcement mechanism — `PlatformGithubAuth.ts` and
`PlatformAccountHttp.ts` both key off it being unset. A league-origin
process with this flag unset serves zero betting UI and zero betting
routes; `bet.proxywar.xyz` is a deliberately separate deployment. This
overhaul never modified `src/server/replay-premiere/wagering/**` logic — see
`PROXYWAR_PREMIERE_RUNBOOK.md` for how the same premiere lifecycle both
surfaces couple to.

### CSP

Every `public.html`-shelled page gets a per-request nonce'd
`Content-Security-Policy` via `pageContentSecurityPolicyWithNonce(
leagueContentSecurityPolicy(), scriptNonce)`; `/league`'s static mirror gets
the bare `leagueContentSecurityPolicy()` (no inline-script nonce needed,
it's a plain generated document). There is no framework-level (e.g. helmet)
CSP middleware in this codebase — CSP is applied explicitly at each render
call site through the one shared function above, which is why there's
exactly one place to audit rather than a global default that could silently
drift per-route. See `PROXYWAR_BETA_RELEASE_CHECKLIST.md` for the specific
CSP header a deployer should verify post-deploy.

### Cross-origin identity (`PROXYWAR_PLATFORM_ORIGIN`)

Accounts, GitHub OAuth, and `/player/:name` live on the platform/apex origin
(`proxywar.xyz`), never the league/beta origin. `PROXYWAR_PLATFORM_ORIGIN`
(`src/core/PlatformOrigin.ts`) is what every league-side consumer resolves
against — e.g. `ProxyWarPublicReadModel.ts`'s `accountUrl` field. The only
cross-origin READ the league origin performs against the platform is
`/api/account/pov-claims`, which is deliberately narrow: it returns only
self-asserted `lineageSlugs`, never authenticates the caller, and answers
`200` with an empty array for any non-allowlisted origin — it is not an
identity check and cannot substitute for one. A real cross-origin identity
handoff (the pattern the betting surface already uses —
`PlatformAccountHttp.ts`'s `/handoff/start` mints a one-time code,
`PlatformHandoffClient.ts` redeems it server-to-server, and
`PROXYWAR_PLATFORM_RETURN_ORIGINS` is the server-side allowlist for which
audiences may complete it) is precedented but not built for any
league-origin surface — see "Builder dashboard: not built" below for the one
place this gap was evaluated and explicitly deferred.

## Builder dashboard: not built (folded in from the Stage 7 decision record)

Spec Stage 7 item 3 asked for a live "my Agents" dashboard reusing platform
accounts + GitHub verification, IF it could be done safely — otherwise ship
the public Builder identity + `/build` flow and document the exact missing
dependency, with no misleading dashboard shell. That investigation happened
and the decision was **not built, this overhaul**:

- The cross-origin auth _mechanism_ is buildable and precedented (the
  betting handoff pattern above could be reused as-is for a new
  `builder-dashboard` audience).
- The actual blocker is the ownership _mapping_, not the auth: nothing in
  this codebase has ever written to `BuilderProfileSchema.verifiedGithub` —
  every registry entry has it `null` today. Platform accounts do carry an
  authenticated GitHub login (`PlatformGithubIdentityLinkStore.ts`), but no
  code path connects "this platform account's verified GitHub login" to
  "this registry Builder is theirs" — deriving that automatically from a
  login/display-name/policy-label match is exactly the account-takeover
  primitive `IdentityMatching.ts` exists to prevent (see
  `PROXYWAR_IDENTITY_MODEL.md`).
- Even with the auth mechanism built, the dashboard would be empty for
  every existing Builder on day one, since `verifiedGithub` only starts
  populating once new `/build` submissions get operator-reviewed and merged.
- Building it anyway would have spent the majority of Stage 7's scope on a
  surface with zero immediate value, at the direct expense of `/build`
  itself.

What shipped instead: the public Builder identity (`/builder/:slug`,
`/builders`, live since Stage 6, unaffected by this decision), and the
`/build` flow's Step 3 registration form, which collects an optional
self-reported `claimedGithub` — kept structurally separate from
`verifiedGithub` in `BuildRegistrationSubmission.ts` — that travels into the
generated GitHub-issue submission with an explicit instruction that an
operator must cross-check it against the submitter's platform-account-linked
GitHub login before ever setting `verifiedGithub` on merge. No new trust
assumption was introduced; this is the same operator-mediated,
never-inferred verification model the identity schemas already require.

**Exact missing dependency for whoever revisits this:** (1) add a
`builder-dashboard` audience to `PROXYWAR_PLATFORM_RETURN_ORIGINS`
(operator, deploy-time, on the platform/apex process); (2) add
`BuilderDashboardAccountLinkStore` + a handoff router mirroring
`BettingPlatformAccountLinkStore`/`BettingIdentityHandoff.ts` exactly (same
state-binding cookie, same one-time-code redemption); (3) add a protected
`/api/dashboard/me` plus a `builder-dashboard-page` client element querying
it and the existing public read model, filtered to Builders whose
`verifiedGithub === githubLogin`; (4) accept that no backfill of existing
registry entries is proposed — that would require an operator to
independently re-verify every existing Builder out of band.

## Known gaps

- No authenticated Builder dashboard (above).
- No real GitHub-login-to-Softmax-control verification mechanism exists yet
  (spec Stage 1 item 2) — see `PROXYWAR_IDENTITY_MODEL.md`.
- Live-premiere fixture admission itself is reliable now (a 2-seat
  aggressive-vs-aggressive matchup, alliance actions disabled, deterministic
  and fast). Three of its four E2E states are real, passing tests (active
  premiere, late-join reads the current position, seek-past-edge rejection).
  The fourth, reveal-after-end, is a documented `test.todo` — the runtime
  reliably reaches liveVisibleSequence one turn short of the bundle's total
  and then never commits the reveal; root cause not confirmed (leading
  hypothesis: `ReplayPremiereChunks.ts`'s chunk-span logic at this
  fixture's extreme 1ms/turn acceleration) but not patched from a guess in
  integrity-critical premiere code. See
  `tests/e2e/PublicProductJourneys.e2e.test.ts`'s own doc on that test for
  the full investigation trail.
