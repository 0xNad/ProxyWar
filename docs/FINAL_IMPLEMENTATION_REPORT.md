# Proxy War Public Product Overhaul — Final Implementation Report

Date: 2026-07-31. Branch `claude/product-overhaul`, 303 commits ahead of
`main`. Written per spec §8 (points 1-9, 11-12; point 10 — deploy — stays
gated, ready, command list attached in `PROXYWAR_BETA_RELEASE_CHECKLIST.md`).
This is a summary; the depth lives in the docs it cites — this report does
not re-derive what they already establish precisely.

## 1. User-visible changes

The public surface went from a league monitor (one static standings table,
raw replay links, a bare `/` redirect to `/league`) to the live league for
autonomous strategy: a homepage that leads with a specific match or Premiere
in one click; persistent Agent/Builder identities with emblems, short
codes, and versions everywhere a raw policy label used to stand alone;
platform accounts with a PoV default on the league page; a curated Featured
Match + Premiere layer with spoiler-safe embargo; a legible broadcast
(competitor rail, War Room event feed, timeline, Analyst mode) replacing
raw telemetry as the default view; Director Cut as the default viewing
product for long archived matches; agent/builder directories and profiles
with evidence-based stats; and a guided `/build` flow from "curious visitor"
to "policy submitted." League surfaces carry zero betting UI throughout —
verified repeatedly this session, not assumed.

## 2. Final route map

See `PROXYWAR_PUBLIC_APP_ARCHITECTURE.md`'s route table for the authoritative
version with shell/CSP detail. Summary:

| Route | Shell | State |
|---|---|---|
| `/` | `public.html` SPA (wrapper-only) / platform root (platform-enabled) | Hero A/B/C per spec §4.4 |
| `/watch` | `public.html` | Event lobby / match archive |
| `/league` | static mirror | Standings, resilience fallback |
| `/agents`, `/agent/:slug` | `public.html` | Directory + profile |
| `/builders`, `/builder/:slug` | `public.html` | Directory + profile |
| `/build` | `public.html` | 7-step guided flow |
| `/about` | `public.html` | — |
| `/match/:matchId` | `public.html` | pre-match / live-premiere / post-match |
| `/premiere/:premiereId` | `index.html` game shell | sealed live, or archived + Director Cut |
| `/ai-league-replay/:runID` | `index.html` game shell | Full Replay / Director Cut / Analyst mode |
| `/openfront-replay/:runID` | redirect | legacy compat, verified same not-found contract as canonical |
| `/account`, `/player/:name` | platform origin | accounts, PoV-parity stats |

## 3. Identity/data architecture

Full detail: `PROXYWAR_IDENTITY_MODEL.md`. Three tracked JSON files
(`builders.json`/`agents.json`/`versions.json`), Zod-validated, no database.
`playerName`-only matching (never GitHub login/display name/policy label —
an account-takeover primitive spec §1.2 named explicitly). Three identity
statuses (`verified`/`house`/`unclaimed`); `status === "verified"` requires
a resolvable `builderId` as a schema-integrity invariant, not just a
convention. Champion-vs-rating provenance preserved end to end
(`ProxyWarPublicReadModel.ts`'s `PublicAgent.activeVersion.source` +
`familyMismatch`). Read model (`ProxyWarPublicReadModel.ts`) normalizes
mirror data, premiere runtime state, and registry data into one typed,
Zod-validated document with atomic publication, last-good snapshots, and
stale banners preserved from the pre-overhaul mirror. No auto-attribution
path exists anywhere — the one real gap here (spec §1.2's own framing) is
that a real GitHub-sign-in-to-Softmax-control verification mechanism was
never built this overhaul (documented, not faked): claims stay
operator-mediated via `/build`'s `claimedGithub` (self-reported, kept
structurally separate from `verifiedGithub`) cross-checked against the
platform account's real OAuth login before merge.

## 4. Featured Match + Premiere mechanics (incl. autocycle/bet-surface coexistence)

Full detail: `PROXYWAR_PREMIERE_RUNBOOK.md`. Two lanes, never mixed:
`premiere:candidates` ranks sealed, unpublished queue matches only;
`feature:candidates` ranks already-published archive matches for Director
Cut promotion. Operator CLIs (`premiere:schedule`/`publish`/`cancel`/
`validate`) drive a `FeaturedMatch` state machine
(`draft→scheduled→published→released`); `premiere-autocycle-due.ts` lets a
scheduled/published record take precedence over the rolling autocycle,
which fills gaps otherwise — verified this session that
`tests/scripts/premiere-autocycle-due.test.ts` (8/8) and the full wagering
suite (`tests/server/replay-premiere/wagering/**`, 215/215 across 29 files)
both stay green, meaning the scheduled-precedence mechanism and the
bet-surface settlement loop coexist without regression. Embargo is a real
gate, not an afterthought: `ReplayPremiereLeakAuditCollector.ts` fetches
public targets and hashes evidence before admission ever proceeds; a failed
audit blocks publication outright. `Match/:matchId`'s three states
(pre-match/live/post-match) render correctly — verified live this session
with a hand-fixtured pre-match `FeaturedMatch` record (see
`artifacts/product-overhaul/after/README.md` for why the default fixture
pipeline doesn't seed one) alongside the completed-episode post-match state.

## 5. Director Cut mechanics

Full detail: `PROXYWAR_DIRECTOR_CUT.md`. Deterministic segment plan (never a
rendered video) from replay/event telemetry — opening, expansion
milestones, alliances, first strikes, major attacks, treaty breaks, nukes,
eliminations, final conflict, merged overlapping windows, `quiet_interval`
gap-fill so `segments` is a complete, gapless partition. Default-on for
archived matches (verified live this session: the toggle button reads
"Director Cut" with `aria-pressed=true` on first load of an archived
match). **Premiere re-watch integration exists and was verified live this
session** — an earlier draft of that doc wrongly claimed it didn't; the
correction (with the exact traced call chain) is in
`PROXYWAR_DIRECTOR_CUT.md`'s "Premiere re-watch integration" section. It
applies only to `rated_coworld`-sourced revealed premieres with a
`director-cut-plan.json` on their run — the one remaining, pre-existing gap
is that the hosted Coworld mirror sync never produces that file for
remote-only episodes (`CoworldLeagueSiteWriter.ts:93-97`).

## 6. Broadcast vs. old overlay

Restructured the existing overlay (decision log, diplomacy icons, war feed,
PoV selector, mobile bottom sheet) rather than rebuilding it: slim header,
dominant map, left competitor rail, right War Room curated event feed,
bottom timeline, lower-thirds pulses, reduced-motion support throughout
(global `animate-pulse` gate added Stage 8, verified Lighthouse a11y
100/100 on every non-replay page tested). Analyst mode is an explicit
toggle exposing the raw decision/event log — verified live this session
(screenshot 14, `artifacts/product-overhaul/after/`) — the default view
never shows it. Mobile: drawer tabs, verified at 390×844 with no horizontal
overflow (Stage 8 E2E case, still green).

## 7. Builder onboarding flow

`/build`'s 7 steps (object model → path choice → identity → run locally →
upload/enter → verify checklist → improve) reuse the existing starter
(`proxywar-coworld-starter`) and `/agent-start` machinery rather than
forking them. Step 3's identity collection produces a validated draft +
prefilled GitHub issue submission, never instant self-service publication
— the same operator-mediated verification model as the identity registry.
Builder dashboard was investigated and explicitly not built this overhaul
(the auth mechanism is buildable/precedented, but `verifiedGithub` has
never been written by any code path, so a dashboard would be empty for
every existing Builder on day one) — full reasoning, decision, and the
exact missing dependency for a future stage are in
`PROXYWAR_PUBLIC_APP_ARCHITECTURE.md`'s "Builder dashboard: not built"
section.

## 8. Security/privacy audit results

Walked live this session against a real spawned fixture server
(`PROXYWAR_LEAGUE_WRAPPER_ONLY=true`, matching the production posture):

- `tests/server/security/PublicSurfaceSecurity.test.ts`: **25/25 passed.**
  Private routes (`/tester-dashboard`, `/admin`, `/api/status`) never 200
  anonymously; every mutating/operator-billed POST/DELETE route 404s;
  `decisions.jsonl`/`visual-report.html` never leave the origin.
- Direct curl confirmation beyond the suite: `/tester-dashboard`, `/admin`,
  `/api/status` all 302; `POST /api/jobs`, `/api/quick-start`,
  `/api/lobby/join`, `/api/nations` all 404.
- Wagering gate: `PROXYWAR_WAGERING_ENABLED` genuinely unset on the
  fixture's process env; `/bet` 302s away; `/api/premieres/current` and
  `/api/premieres/points/leaderboard` both 404 on the league-origin
  process. `bet.proxywar.xyz`-adjacent test suites (wagering: 215/215
  across 29 files; autocycle-due: 8/8) stay green, confirming the coupling
  this overhaul carries inert is genuinely untouched.
- CSP: confirmed live via `curl -I`, not assumed — `connect-src 'self'
  https://proxywar.xyz` is present on `/watch` (a representative
  `public.html` page). This is the exact gap the Stage 0 audit found on
  the pre-overhaul beta (`connect-src 'self'` alone, silently blocking the
  PoV-claims fetch) — confirmed fixed, not regressed.
- Old-URL compat: `/openfront-replay/nonexistent` and
  `/ai-league-replay/nonexistent` both correctly 404 with the identical
  contract.

## 9. Test/build results (this session, full matrix)

| Command | Result |
|---|---|
| `npm run inst` | clean |
| `npm exec -- tsc --noEmit` | clean |
| `npm run lint` | 6 errors, all pre-existing (`AiLeagueReplayOverlay.ts` unused vars), unchanged across every check this session |
| `npm test` (client+general) | **367/367 files, 4259 passed, 3 todo, 0 failed** |
| `npm test` (server, `vitest run tests/server`) | **199/199 files, 2292 passed, 0 failed** |
| `npm run test:e2e` | **1/1 file, 23 passed, 1 todo, 0 failed** |
| `npx vite build` | clean, ~1.5s |
| Security suite | 25/25 |
| Wagering suite | 215/215 across 29 files |
| Autocycle-due suite | 8/8 |

Every disk-floor-gated suite from earlier in this overhaul (the ~23 files
that failed on `durable_write_free_space_floor_not_met` through Stage 8)
now passes — internal disk free space crossed the 15 GiB floor as an
incidental side effect of this session's own scratch cleanup, not a
deliberate Stage 8B remediation (that remains fully un-executed and
operator-gated; nothing outside this task's own scratch was touched). See
`docs/project-state/known-problems.md` (gitignored, local) for the dated
record.

**3 todo, not 0**, and this is reported honestly rather than rounded away:
`tests/e2e/PublicProductJourneys.e2e.test.ts` has 1 documented
`test.todo` (premiere reveal-after-end — see §12); `npm test`'s 3 todo are
pre-existing, unrelated to this overhaul.

## 10. Deployed URL + smoke results, or the exact gate/blocker

**Not deployed.** Deployment is an operator-gated outward action per
`AGENTS.md`; no push, deploy, or launchd change was made or attempted this
session. Everything required for a deploy is prepared and validated
locally:

- Exact command list: `PROXYWAR_BETA_RELEASE_CHECKLIST.md` §1-2 (build +
  the specific `launchctl bootstrap`/`proxywar-beta-launchd-restart.mjs`
  invocations and which `deploy/mac/*.plist` files are involved).
- Cutover flag verified real and near-free (§3 of this report /
  `PROXYWAR_BETA_RELEASE_CHECKLIST.md`'s "Cutover switch, verified"
  section): `PROXYWAR_LEAGUE_WRAPPER_ONLY` is the entire mechanism, already
  the existing convention — no new or renamed flag.
- Rollback path documented with the exact current-deployed-state facts
  and verified-parseable (not executed) rollback commands
  (`PROXYWAR_BETA_RELEASE_CHECKLIST.md`'s "Rollback path" section).
- Post-deploy smoke checklist is the literal spec §9.3 list, walked
  locally against the fixture server this session (§8 above + the
  screenshot capture in §11) with one addition: the `X-Forwarded-For`
  local-testing note for the live-premiere smoke item.

**The single blocker to an actual deploy: the operator gate itself.**
Request it with the command list above when ready.

## 11. Before/after screenshot paths

- Before: `artifacts/product-overhaul/before/` (Stage 0, 15 screenshots
  across 4 viewports of the pre-overhaul beta/apex).
- After: `artifacts/product-overhaul/after/` (this session, 14 screenshots,
  desktop 1440×900 unless noted, `/premiere/:id` also captured at
  390×844). Indexed with route/state notes in that directory's own
  `README.md`, which also documents two genuine findings surfaced while
  capturing them (both already folded into
  `PROXYWAR_BETA_RELEASE_CHECKLIST.md` and this report — not just
  screenshot trivia):
  1. The premiere interaction/session layer needs a trusted
     `X-Forwarded-For` that only a real reverse proxy (or a simulated one
     in local testing) provides — a local-fixture-testing gap, not a
     production bug, verified by simulating the header and watching the
     premiere broadcast render correctly.
  2. `/ai-league-replay/:runID` and `/ai-league-runs/:runID/*` require a
     `league`-prefixed run id in wrapper-only mode
     (`isProxyWarPublicLeaguePath`) — real production run ids are always
     shaped this way, so it never surfaces there; only matters for ad-hoc
     fixture run-id naming.

## 12. Remaining follow-ups (non-blocking)

1. **Premiere reveal-after-end** (fixture-testing scope only): the
   2-seat, alliance-actions-disabled exhibition match reliably reaches
   `liveVisibleSequence` one turn short of its total, then never commits
   the reveal — confirmed stuck through 330+ continuous seconds of
   polling across two independent runs. Traced deep into
   `ReplayPremiereRuntimeCoordinator.ts`/`ReplayPremiereChunks.ts` without
   a confirmed root cause (leading hypothesis: `maxPresentationSpanMs`'s
   chunk-flush span logic interacting badly with this fixture's extreme
   1ms/turn acceleration); deliberately left as `test.todo` with the full
   investigation trail and a concrete next step rather than patching
   integrity-critical premiere code from a guess. The other three
   live-premiere E2E states (active, late-join, no-seek-past-edge) are
   real, passing tests against the same admitted premiere.
2. **Hosted-mirror `director-cut-plan.json` generation**: the hosted
   Coworld mirror sync (`coworld-league-mirror.ts`) only ever receives
   `game-record.json`/`decisions.jsonl` from the real remote platform, so
   a purely hosted-mirror episode (never locally produced) has no local
   run directory to generate a Director Cut plan in. The wiring to render
   one is real and verified (§5); the input data isn't produced for this
   one episode class. Pre-existing, unchanged by this overhaul.
3. **Builder dashboard**: not built, documented gap with the exact missing
   dependency list (§7). Real work, not urgent — the public Builder
   identity + `/build` flow are complete without it.
4. **Real GitHub-sign-in-to-Softmax-control verification**: unsolved by
   design (spec §1.2's own framing) — deriving ownership automatically
   from any user-settable namespace is the account-takeover primitive the
   identity model exists to prevent. Needs a real, deliberate mechanism
   design, out of this overhaul's authority to invent unilaterally.
5. **`origin/main` drift**: 3 commits (`1855d5575`/`4b66af87b`/`6f366d8ed`)
   landed on `main` past this overhaul's `main` ancestor (`c35e6be87`),
   touching only `coworld-adapter/commissioner/**` — zero file overlap
   with this overhaul, confirmed by diff. Reconcile before merging
   `claude/product-overhaul` toward `main`, not before this cutover.
6. **Storage remediation (Stage 8B)**: never executed — remains fully
   operator-gated per its own spec section. Not currently blocking (see
   §9's disk-floor note), but the inventory/proposal/approval process
   itself was never run.
7. `main-bzYr7PX1.js` (3.17 MB uncompressed, 850 KB gzip) exceeds Vite's
   500 KB chunk-size warning — pre-existing, not a regression introduced
   this session; a future stage could code-split it further.
