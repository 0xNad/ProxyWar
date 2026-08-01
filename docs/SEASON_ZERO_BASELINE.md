# Season Zero Baseline — Phase 0/1 Reconciliation

Written 2026-08-01 by the stabilize-foundation pass. Factual snapshot only;
supersedes any conflicting claim in the uploaded implementation report where this doc cites live/repo evidence.

## Branch state

- Worktree: `/Volumes/ProxyWar Workspace/ProxyWar/worktrees/product-overhaul`,
  branch `claude/product-overhaul`, HEAD `f7cd6870d`.
- Divergence from `origin/main`: **327 commits ahead, 0 behind.** `main` has
  nothing this branch lacks — every file/commit on `main` is already an
  ancestor of this branch tip. `git log --oneline origin/main..HEAD | wc -l`
  = 327; `git log --oneline HEAD..origin/main | wc -l` = 0.
- 5 concurrent sessions shared this worktree during this pass; several
  sibling commits landed on the branch mid-task (HEAD moved `09aeba224` ->
  `432e1fbe7` -> `b9d389be0` -> current while this doc was being written).
  Claims below are pinned to the HEAD above; re-run the commands to refresh.

## Deployed state

- `com.proxywar.beta` (launchd, PID live at check time) listens on
  `127.0.0.1:8788`, cwd `/Users/claude/Documents/proxywar_worktrees/replay-premiere-release-candidate`,
  whose `git rev-parse HEAD` **matches this branch's tip exactly** at every
  check performed (confirmed 3 times as HEAD advanced: `09aeba224`, then
  `b9d389be0`) — i.e. that worktree tracks `claude/product-overhaul` live, not
  a frozen release-candidate snapshot.
- `beta.proxywar.xyz` (Cloudflare-fronted) proxies to that process. Routes
  verified 200 externally: `/`, `/watch`, `/league`, `/build`, `/about`,
  `/agents`, `/builders`, `/match/<episodeRequestId>`. `/bet` on the league
  origin returns 503 (no handler) — confirmed no public betting surface on
  the league line. `bet.proxywar.xyz/bet` (separate origin, port 8792,
  `com.proxywar.betautocycle`) returns 302, as designed — betting stays off
  the league surface per the 2026-07-27 standing decision.
- Other active launchd services: `com.proxywar.platform` (port 8793, apex
  `proxywar.xyz` account/session origin, wagering off, independent of the
  league), `com.proxywar.betautocycle` (port 8792, `bet.proxywar.xyz`),
  `com.proxywar.league-mirror` (5-min interval, serves from
  `/Users/claude/Documents/proxywar_main/.claude/worktrees/main-release`, a
  **different, older checkout** than the live beta — mirror-only, does not
  serve pages), `com.proxywar.premiere-loop`. `com.proxywar.ops-digest` and
  `com.proxywar.storage-maintenance` are scheduled/on-demand (not
  continuously listening).
- Feature flags observed on the beta env file (non-secret keys only):
  `PROXYWAR_BETA_ENABLED=true`, `PROXYWAR_LEAGUE_WRAPPER_ONLY=true` (serves
  the pre-generated static mirror + `public.html` SPA, not full live-hosting
  machinery), `PROXYWAR_CLIPS_ENABLED=false`. Live-verified via
  `GET /api/clip-capabilities`: `{"premiereGenerationEnabled":false,
  "leagueGenerationEnabled":false}` — matches the env flag, not stale.

## Season-Zero-doc claims: stale vs true

The activation prompt's context snapshot said hosted Director Cuts, drama
recaps, per-episode match pages, and the beta deployment were still open gaps.
All four are **DONE and live** — do not re-litigate:

- **Hosted Director Cut**: live episode `ereq_14740723-9fd8-4715-a691-cdc86b4c9404`
  (round 1114, World map, completed 2026-08-01T14:19:41Z) carries
  `directorCut: {durationEstimateSeconds: 417, segmentCount: 21}` in the live
  `data.json`, and `GET /api/league-runs/<runKey>/director-cut` returns
  HTTP 302 (redirects to the rendered asset) for that same episode.
- **Drama recaps**: `GET /ai-league-runs/<runKey>/match-recap.json` for the
  same episode returns a real generated recap (schemaVersion 3, "32
  alliances, 5 betrayals, 56 first strikes, 6 eliminations and 1 final
  clash", turn-stamped beats) — not a placeholder.
- **Per-episode match pages**: `GET /match/ereq_14740723-9fd8-4715-a691-cdc86b4c9404`
  returns HTTP 200 with real episode content (verified directly and via the
  e2e suite's `direct reload of a league-episode match page` case).
- **Beta deployment**: see "Deployed state" above — live, matches branch tip.

## Lint

`npm run lint`: **7 errors -> 0 errors.** Disposition:

1. `.omp/hooks/pre/proxywar-guard.ts` parse error (project-service can't
   resolve it — not in `tsconfig.json`'s `include`). Fixed by adding it to
   `eslint.config.js`'s `allowDefaultProject` list, the repo's existing
   convention for standalone tooling scripts outside the main TS project
   (`eslint.config.js`, `scripts/sync-assets.mjs` already use this). Not a
   rule weakening — the file still lints, just without type-aware rules
   (same treatment plain `.js`/`.mjs` files already get via
   `disableTypeChecked`).
2. 6x `no-unused-vars` in `src/client/AiLeagueReplayOverlay.ts`
   (`actionCounts`, `agentCount`, `maxSteps`, `configuredOpponentCount`,
   `mapName` in `overlayDetailsHtml`, plus the module-level
   `actionLabelFromKind` function). Traced each one: genuinely dead, not a
   wiring bug. The "playstyle badges" / "Plays mostly" panel line these fed
   was already removed from the product; `tests/client/AiLeagueReplayOverlay.test.ts`
   explicitly documents this ("the metric row above is what summary
   actionCounts still drive") and asserts `.ai-league-playstyle` never
   renders in three separate cases. The equivalent match-setup summary is
   already produced correctly by the separate, still-used `matchSubtitle()`
   (rendered in the panel header). Removed the 6 flagged declarations plus
   their now-orphaned support (`summaryActionCounts()`,
   `AI_LEAGUE_ACTION_LABEL_KEYS`, the `.ai-league-playstyle` CSS rule) so
   nothing was left half-referenced. Full unit suite for this file (and the
   whole replay-premiere suite) reverified green after the removal.

**112 `@typescript-eslint/prefer-nullish-coalescing` warnings left
deliberately** (zero errors is the bar). 90 of 112 (80%) are in
`src/server/agents/AgentPlannerExecutor.ts`, a file `AGENTS.md` requires
independent review before touching. Sampled several sites directly
(`OpenRouterLlmProvider.ts`, `GithubOAuthClient.ts`): the dominant pattern
repo-wide is `env.X?.trim() || fallback`, where `||` is load-bearing — an
empty string after `.trim()` is falsy and must still fall through to the
default; `??` would not treat `""` as absent, silently returning empty
instead of the intended default. Real per-site behavior risk, not a
mechanical rewrite — left everywhere and recorded here instead of bulk-fixed.

## Reveal-after-end root cause + fix

**Not a runtime bug.** `bootstrap()`'s `integrityScope.authoritativeResult` is
a hardcoded `z.literal("not_revealed")` in `ReplayPremiereWire.ts`'s
`createPremierePublicBootstrap` — enforced by `ReplayPremierePublicPage.ts`'s
`spoilerNeutralModel`, which throws if that field is ever anything else (the
bootstrap payload is deliberately spoiler-neutral so it's safe to cache/embed
before reveal). The E2E `test.todo`'s own investigation trail polled that
field and concluded the reveal was stuck; it never checked the actual reveal
endpoint.

Reproduced directly against a real admitted premiere: cloned the worktree to
an isolated clean checkout (the admission's build-provenance gate requires
`git status`/`git diff HEAD` both empty), admitted the same fixture premiere
(`FIXTURE_ADMIT_LIVE_PREMIERE=1`, 21,400-turn 2-seat deterministic match,
`--playback-turn-interval-ms=1`), and added temporary `console.error`
instrumentation in `synchronizeUnlocked()` (reverted after use — zero diff
vs HEAD confirmed). Observed: `nextDraftIndex` advanced through all 24
drafts on the scheduler's real timer chain, the terminal draft's
elapsed-time gate cleared (`willBreak=false`) the moment real playback
caught up, and `commitTerminalReveal()` completed first-try — no retry, no
error, no deadlock. Then confirmed directly: `GET
/api/premieres/prem_fixture0premiere01/reveal` returned HTTP 200 with the
full correct result (`Fixture aggressive` won, `turnCount: 21400`) — the
same endpoint `ReplayPremiereNetwork.ts`'s real client polls via
`revealPath()`, never `bootstrap()`.

**Fix**: rewrote `test.todo` into a real test that polls `GET .../reveal`
(matching production client behavior) with a 240s deadline (two 60s
`REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS` windows + ~21s of 1ms/turn playback).
Verified passing at **140,218ms** in the isolated clean-checkout run,
matching the predicted timing almost exactly. No runtime code changed —
production pacing (`PREMIERE_REAL_TURN_INTERVAL_MS`) was never affected by
this fixture-only 1ms/turn acceleration or by this bug.

**Verification**: `npx vitest run tests/server/replay-premiere
tests/client/AiLeagueReplayOverlay.test.ts` — **784/784 passed**, 60/60
files. `npm run test:e2e` in the shared (dirty, multi-session) worktree:
**23/23 fast-fixture tests pass**; the live-premiere `beforeAll` correctly
fails fast on the clean-checkout gate (expected, given 5 concurrent
sessions' uncommitted work) — that block, including the new reveal test,
was verified separately in the isolated clean clone above (not gated there).

## Branch hygiene

Removed 270 files (~120MB), zero cross-references from any tracked file,
absent from `origin/main`, not wired into any `package.json` script or
`src/` import:

- `tmp/` (120MB): iterative draft renders (PDF/PNG/docx) for two internal
  stakeholder docs ("Let's Play Proxy War" collaboration brief and new-player
  guide) plus an unrelated ML experiment (`proxywar-sft-mini` training
  data/LoRA `.safetensors` adapter weights, a `crewrift` notebook demo bundle
  with vendored `.whl` files). First added in `644c9be4d` ("WIP checkpoint:
  local integration testing"). Never gitignored.
- `output/pdf/*.pdf` (2 files): generated call-brief/cheat-sheet PDFs for an
  external Softmax stakeholder call. Same category.
- `.AGENTS.md.pre-20260728.bak`, `.CLAUDE.local.md.pre-20260728.bak`: dated
  backup copies of instruction files (added `564a2f599`), superseded by the
  live files, unreferenced anywhere.

**Not removed** (traced and confirmed runtime/docs-referenced, contrary to
first appearance as noise): `DEMO.md`, `RUNBOOK.md`,
`autocycle-premiere.sh`, `cycle-premiere.sh`, `premiere-queue-lib.sh`,
`generate-premiere-queue.sh`, `deploy/mac/`, `verify-github-signin.sh`,
`public.html` (the served SPA shell, referenced from
`docs/FINAL_IMPLEMENTATION_REPORT.md`). No ambiguous cases found.

Screenshots: 182 tracked (all legitimate — mostly under
`docs/`/verification-evidence paths, none in the removed `tmp/`/`output/`
noise); 208 additional untracked files matched by `.gitignore` (properly
ignored generated artifacts, not noise).

Commit-history note: the branch-hygiene removal landed bundled into the lint
commit (`999402eb0`) rather than its own commit — `git rm` pre-stages
deletions, and the `git commit` for the lint fix picked up the whole index
rather than only the explicitly-`git add`ed lint files. The content of both
changes is correct and intentional; only the commit boundary is imprecise.
Not corrected via history rewrite (`--amend`/rebase) because this is a live
shared branch with 5 concurrent sessions actively committing — rewriting
history here risks breaking a sibling's in-flight work, which is exactly the
kind of destructive action `AGENTS.md`/working-agreements gate on explicit
operator approval.

## Main reconciliation (report only — not executed)

`claude/product-overhaul` is 327 commits ahead of `origin/main`, 0 behind:
every commit on `main` is already an ancestor of this branch. A merge or
fast-forward of `main` onto this branch tip would therefore be a pure
fast-forward from Git's perspective — **no merge conflicts are structurally
possible** (main has no divergent history to conflict with).

`main` is public (`https://github.com/0xNad/ProxyWar`); this branch carries
327 commits unreviewed by the public line, including the full
replay-premiere/wagering, identity/builder-claim, season, and analytics
subsystems. "No conflicts" is not "safe to merge blindly". Recommended
procedure for whoever holds push authority:

1. Confirm the branch is fully green (this doc's Validation section) at the
   exact SHA about to be promoted.
2. `git diff origin/main..claude/product-overhaul --stat` for a full public
   surface-area review — 327 commits touching this many subsystems is not a
   rubber-stamp fast-forward for a public repo.
3. Grep the full diff for wagering/betting/points code before promoting, per
   the standing 2026-07-27 decision that the league line must carry zero
   wagering code (the betting surface is a separate fork,
   `claude/betting`/`bet-origin`, never merged to `main`).
4. If clean: `git push origin claude/product-overhaul:main` is a fast-forward
   (`git merge-base --is-ancestor origin/main claude/product-overhaul` is
   true), so no merge commit is required — but this is still a
   force-push-adjacent, history-altering action on the public default branch
   and is explicitly operator-gated per `AGENTS.md`. **Not executed here.**
5. Keep a rollback point: tag `origin/main`'s pre-merge SHA before pushing.

## Validation matrix (this pass)

| Check | Result |
| --- | --- |
| `npm exec -- tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 112 warnings (see above) |
| `npm run build-prod` | clean (`tsc --noEmit` + `vite build` both exit 0) |
| `npm test` (unit, excludes e2e) | 4560 passed, 11 skipped, 3 todo, **3 failed** — see below |
| `npm run test:e2e` | 23/27 pass directly; live-premiere block gated by clean-checkout requirement in this dirty shared tree, verified separately (140,218ms pass) in an isolated clean clone |

`npm test` 3 failures (`ProxyWarPublicReadModel.test.ts`,
`AnalyticsServerIntegration.test.ts`, and one other analytics case) are in
files this pass never touched (`ProxyWarPublicReadModel.ts`, the analytics
subsystem) and were unstaged-modified by concurrent sibling sessions
(`reconcile.ReadModelHeroIntegration`, `reconcile.DashboardAuthScout`, and
the analytics-focused sessions per the live roster) at the moment this suite
ran. Not this pass's regression — reported, not fixed, per this task's
explicit file-ownership boundary.

## Deploy state

Beta already serves this branch's tip live (confirmed above — the serving
worktree tracks `claude/product-overhaul` directly; no separate deploy step
exists). No redeploy was required: the lint fix, reveal-after-end test fix,
and branch-hygiene removal are non-runtime or a confirmed no-op revert (the
temporary debug instrumentation). Post-deploy smoke covered above. Rollback
point: HEAD before this pass was `09aeba224`.
