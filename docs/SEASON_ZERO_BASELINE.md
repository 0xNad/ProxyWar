# Season Zero Baseline — Phase 0/1 Reconciliation

Written 2026-08-01 by the stabilize-foundation pass. Factual snapshot only;
supersedes any conflicting claim in the uploaded implementation report where this doc cites live/repo evidence.

## Branch state

- Worktree: `/Volumes/ProxyWar Workspace/ProxyWar/worktrees/product-overhaul`,
  branch `claude/product-overhaul`, final consolidated HEAD `c9a224eea`
  (pushed to `origin/claude/product-overhaul`, fast-forward, no force).
- Divergence from `origin/main`: **343 commits ahead, 0 behind** (re-verified
  at final HEAD). `main` has nothing this branch lacks.
- 6+ concurrent sessions shared this worktree during this pass (sz-season,
  sz-analytics, sz-identity, sz-pipeline, plus this stabilize pass and
  several `reconcile.*` subagents). HEAD moved repeatedly while this doc was
  being written: `09aeba224` -> `432e1fbe7` -> `b9d389be0` ->
  `999402eb0`(lint+hygiene) -> `f7cd6870d` -> ... -> `cf5c90fae`(analytics
  fix 1) -> `6618da9ad`(feature:candidates identity fix, this pass) ->
  `52a9164cd`(regression test, this pass) -> `c9a224eea`(analytics fix 2,
  final). All commands below were re-run at the final HEAD before deploy.

## Deployed state

- `com.proxywar.beta` (launchd) listens on `127.0.0.1:8788`, cwd
  `/Users/claude/Documents/proxywar_worktrees/replay-premiere-release-candidate`.
  **Redeployed this pass**: fetched `claude/product-overhaul` into that
  worktree, `git checkout --detach c9a224eea` (from `b9d389be0`), `npm ci`,
  `npm exec -- tsc --noEmit` (0 errors), `npm run build-prod` (clean),
  `launchctl kickstart -k gui/$UID/com.proxywar.beta` (PID `52367` ->
  `85998`), ready on `:8788` within 1s. `git rev-parse HEAD` in that
  worktree confirmed `c9a224eea` post-restart, matching the pushed branch
  tip exactly.
- `beta.proxywar.xyz` (Cloudflare-fronted) proxies to that process. Routes
  verified 200 externally post-redeploy: `/`, `/league`,
  `/match/ereq_717259dd-e723-4097-9505-8b893963892d` (real title: "Captain
  Underpants Maximum Aura vs PeePee7 +10 more — Pangaea, Round 1119"),
  `/premiere/prem_89156f725b6402e3cbf79b2a` (200, real premiere page). `/bet`
  on the league origin returns 503 (no handler) — confirmed no public
  betting surface on the league line. `bet.proxywar.xyz/bet` (separate
  origin, port 8792, `com.proxywar.betautocycle`) returns 302, as designed —
  betting stays off the league surface per the 2026-07-27 standing decision.
  `com.proxywar.platform` and `com.proxywar.betautocycle` were **not
  touched** by this pass's restart (platform stayed crashed at `-9` exactly
  as found; betautocycle's PID `383` unchanged) — league-beta-only, per this
  task's scope.
- **Correction to an earlier draft of this doc**: `com.proxywar.league-mirror`'s
  plist `WorkingDirectory` key reads
  `.../main-release` (a separate, far older checkout, currently
  `c35e6be87` before this pass touched it), which looks like the mirror runs
  from a stale checkout independent of beta. It does not: the plist also
  sets `PROXYWAR_PROJECT_DIR=.../replay-premiere-release-candidate`, and
  `start-proxywar-league-mirror.zsh` does `PROJECT_DIR="${PROXYWAR_PROJECT_DIR:-...}"`
  then `cd "$PROJECT_DIR"` before running `npm run league:mirror` — i.e. the
  mirror actually runs from the **same** worktree as beta, already updated
  above; `WorkingDirectory` is launchd's own pre-script cwd and is unused by
  the script. Verified live: `launchctl kickstart -k
  gui/$UID/com.proxywar.league-mirror` after the beta redeploy produced a
  fresh `league-mirror.log` entry at `19:48:01` local
  (`~/Library/Application Support/ProxyWar/storage/league-mirror.log`)
  showing the **new** backfill pipeline running end to end on the new code:
  `match recap re-curated ... (curated 66, 16 recap beat(s))`, three `match
  state series generated for <runKey> (N sample(s))` lines, `director cut
  plan generated for <runKey> (spectator-telemetry, 41 segment(s))`, `site
  updated: .../league/index.html (18 standings, 10 battles)`. (The
  `main-release` checkout was also fast-forwarded to `c9a224eea` out of an
  abundance of caution / to restore the "one release SHA" invariant
  documented as previously-resolved in `known-problems.md`, even though
  it's confirmed unused by the running mirror process — it is otherwise
  idle infrastructure and touching it changed no runtime behavior.)
- Other active launchd services: `com.proxywar.platform` (port 8793, apex
  `proxywar.xyz` account/session origin, wagering off, independent of the
  league — untouched), `com.proxywar.betautocycle` (port 8792,
  `bet.proxywar.xyz` — untouched), `com.proxywar.premiere-loop`.
  `com.proxywar.ops-digest` and `com.proxywar.storage-maintenance` are
  scheduled/on-demand (not continuously listening).
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

### Promotion review completed 2026-08-01 — push withheld pending operator decision

Executed by `main-promote`. Divergence re-verified at the true final tip after
6 concurrent sibling sessions finished landing work in this shared worktree:
**351 commits ahead of `origin/main` (`6f366d8ed`), 0 behind**, tip
`c66f1d754d7f53c5e991d61a049bc6b5fa2a900a`
(`git merge-base --is-ancestor origin/main HEAD` true — still a structurally
clean fast-forward).

**Step 1 — full validation at the promoted tip, all green:**

| Check | Result |
| --- | --- |
| `npm exec -- tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 113 warnings (nullish-coalescing only) |
| `npm test` | 415+235 files, 4898+2739 tests passed, 3 todo, 0 failed |
| `npm run test:e2e` | 27/27 pass |
| `npm run build-prod` | clean (`tsc --noEmit` + `vite build` both exit 0) |

**Step 2 — public-surface diff review, two hygiene issues found and fixed**
(both committed to `claude/product-overhaul`, both re-validated above):

1. `.omp/` (16 files: agent role prompts, guard hook, model-routing
   SETUP.md) was tracked and about to reach the public default branch even
   though `SETUP.md` itself documents it as gitignored "public-repo hygiene"
   alongside `.claude/`/`.codex/` — the gitignore entries were simply never
   added. Fixed: added `.omp/`, `WATCHDOG.md`, `WATCHDOG.yml` to
   `.gitignore` and untracked (commit `681b54e81`).
2. `DEFAULT_FFMPEG_BINARY` (`replay-premiere-clip-render-lib.ts`) and
   `premiereSuppressionStorageStateDir()`'s fallback
   (`CoworldLeaguePremiereSuppression.ts`) hardcoded the literal operator
   home path `/Users/claude/...` as a compiled-in public default, and a
   test asserted that exact literal — breaking for any contributor/CI whose
   home directory differs, and leaking the operator's real macOS username.
   Both already have working env-var overrides
   (`PROXYWAR_CLIP_FFMPEG_BIN`, `PROXYWAR_STORAGE_STATE_DIR`); only the
   compiled-in default changed, from a literal to `os.homedir()`-derived
   (identical resolved value on the real deployment machine, no behavior
   change there). Fixed: commit `bb6280483`.

No secrets, API keys, tokens, or real personal emails found across the full
`origin/main..HEAD` diff (grepped for key/token/secret/bearer/PEM patterns
and email addresses; only test fixtures with obviously-fake values matched,
e.g. `clip-test@proxywar.invalid`, `Bearer abcdefghijklmnopqrstuvwxyz012345`
in a redaction test). No TODOs referencing private/internal-only context.

**Step 3 — the wagering surface is real, not a false alarm.** An earlier
brief in this task characterized the 2026-07-27 "zero wagering code on the
league line" decision as being about the *deployed* origin only, and treated
this as a pure verification step. The operator corrected that reading
mid-task: the standing decision, as recorded just above in this same
section (point 3), is about `main` — the public default branch — carrying
zero wagering code, full stop; the betting surface is a separate fork never
merged to `main`. This branch plainly contains wagering/betting source and
tests. Documented as an inventory instead of a merge precondition:

- **86 tracked files, 19,279 LOC** touch wagering/betting
  (`src/client/prediction/wagering/**`,
  `src/server/replay-premiere/wagering/**`,
  `src/scripts/premiere-wagering/**`, `BettingProfileServiceAuth.ts`,
  `PlatformBettingHandoff`/`PlatformBettingProfileProjection` HTTP glue, and
  their matching test files): 49 source files / 9,588 LOC + 37 test files /
  9,691 LOC. **0 of these 86 files exist on `origin/main` today** — `main`
  is genuinely wagering-free right now.
- **Gating is structural, not a convention.** `PROXYWAR_WAGERING_ENABLED`
  (absent by default) gates every mount point: `ai-agent-demo-server.ts`
  hard-404s `/api/premieres/points/leaderboard` when unset
  (`if (!pointsRoutesEnabled) { res.status(404)...; return; }`);
  `ReplayPremiereInteractions`'s market-mutating methods throw
  `invalidInteraction("wagering_disabled")` unless `wageringEnabled` was
  explicitly passed in at construction (default `false`); `PlatformAccountHttp.ts`
  and `PlatformGithubAuth.ts` are documented and structurally verified to
  never read the flag at all, so account/identity features are unaffected
  either way. Exercised by `PlatformBettingHandoff.test.ts`,
  `PlatformBettingProfileProjection.test.ts`, `PlatformRootPage.test.ts`,
  and `PlayerProfileIsolation.test.ts` under both flag states — all green as
  part of the Step 1 run above. Live confirmation already on record above
  ("Deployed state"): the league origin's `/bet` returns 503 (no handler);
  `bet.proxywar.xyz` is the separate origin that actually serves it.
- **This code is already public.** `claude/product-overhaul` (current tip
  `c66f1d754`) is already pushed to `origin` — the same public
  `0xNad/ProxyWar` GitHub repo — just not on the default branch. Anyone
  browsing branches on the public repo can already read this code today;
  promoting to `main` would change *default-branch visibility and
  discoverability*, not first-time public existence.

**Step 4/5 — not executed.** No tag was cut, `origin/main` was not
force-fetched or fast-forwarded, and no filtered/wagering-free promotion
branch was built (that is itself a significant surgical action requiring
its own explicit go-ahead, not something to improvise under a "push
withheld" instruction). `origin/main` remains at `6f366d8ed3cb814b61a0c7`
`3ac4be6ca1e60ef961`, untouched.

**Decision needed from the operator.** Options, as scoped by the operator
mid-task:

- **(a) Promote as-is**, explicitly acknowledging the wagering surface is
  already public on the branch (and, as above, technically already
  reachable on `origin` today via the branch ref) and choosing to accept it
  reaching `main`'s default-branch visibility too.
- **(b) Build a wagering-free promotion branch** — a filtered/rebased
  branch that drops the 86 files above (and anything that imports them)
  before promoting to `main`. Nontrivial: several non-wagering files
  (`PlatformAccountHttp.ts` request handlers, `ai-agent-demo-server.ts`
  route wiring, `ReplayPremiereInteractions.ts`,
  `ReplayPremiereRuntimeCoordinator.ts`, `ReplayPremiereStartup.ts`) hold
  conditional wagering branches inline rather than importing a cleanly
  separable module, so this is a real edit/rebase job, not a mechanical
  file-drop, and needs its own plan and review.
- **(c) Leave `main` where it is** and keep `claude/product-overhaul` as the
  operative branch for every deployed service (as today — every live
  ProxyWar process already fetches this branch, never `main`).

The two hygiene fixes above (`.omp/` untrack, hardcoded-path removal) are
kept regardless of which option is chosen — they are correct independent of
the wagering question and already committed to `claude/product-overhaul`.

## Validation matrix (final consolidated HEAD `c9a224eea`)

Full matrix re-run at final HEAD, after sz-season/sz-analytics/sz-identity
all landed and the tree was fully clean (`git status --short` empty):

| Check | Result |
| --- | --- |
| `npm exec -- tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 113 warnings (nullish-coalescing only, see above) |
| `npm run build-prod` | clean (`tsc --noEmit` + `vite build` both exit 0) |
| `npm test` (unit, excludes e2e) | **4883 passed, 3 todo, 0 failed** (415 + 235 test files, two-stage `vitest` + `vitest tests/server`) |
| `npm run test:e2e` | 27/27 pass on the clean consolidated tree (`tests/e2e/PublicProductJourneys.e2e.test.ts`, includes the now-real reveal-after-end test) |

The 3 unit-test failures reported earlier in this pass
(`ProxyWarPublicReadModel.test.ts`, 2 analytics cases) were transient —
concurrent sibling sessions' in-flight uncommitted edits at the moment of
that earlier run, not a real regression. Re-run at this final, fully-landed
HEAD: all green, confirming that diagnosis.

A genuine bug was found and fixed during this final consolidation pass
(commits `6618da9ad` + `52a9164cd`, both this session, both zero-error/zero-warning-added on their own files): `feature:candidates` (the
CLI that ranks archive-lane Featured Event candidates) hardcoded
`agentId: null, agentVersionId: null` for every participant in every
candidate it has ever produced, because `CoworldLeagueSiteWriter.ts`'s
per-episode player rows carry no policy-label fields (only the
standings table does) and the call site never threaded standings through.
Concretely this means **`isPubliclyPromotable` (`EventPackageGate.ts`)
would have rejected every single archive-lane candidate** the moment an
operator tried to promote one, since it requires every participant's
identity fully resolved — a real, previously-invisible blocker on Season
Zero's archive-lane promotion path (the queue's currently-`archive`-lane
candidates are 253/253 ranked but all synthetically produced 100%
`unmapped` fields before the fix). Fixed by threading the mirror's live
`standings` array (already loaded for the same request) into
`buildParticipants()` so it looks up each player's *current* rating/champion
policy label by name, falling back to `null` only for players with no
registered `AgentProfile` at all (never fabricated). Verified against real
production data (`PROXYWAR_ARTIFACTS_ROOT` pointed at
`/Users/claude/Documents/proxywar_main/artifacts`): before the fix, 0/12
participants across the top-10 ranked candidates resolved an
`agentVersionId`; after, 11/12 resolve correctly (the 12th, "James Botts",
has no registered `AgentProfile` — a genuine identity gap, not a bug).
Added a regression test
(`tests/scripts/feature-candidates.test.ts`, "resolves each participant's
CURRENT agentVersionId from live standings, never fabricates one for an
unmapped player") against the real, committed `resources/identity/`
registry data — 9/9 tests pass in that file, 4883/4883 unit tests pass
repo-wide with the fix in.

## Deploy state

**Redeployed this pass** to the final consolidated HEAD (see "Deployed
state" above for the full restart/verification trail). Sequence:
`git push origin claude/product-overhaul` (fast-forward,
`b9d389be0..c9a224eea`, no force) -> fetch + `git checkout --detach
c9a224eea` in the release-candidate worktree -> `npm ci` -> `tsc --noEmit`
(0 errors) -> `build-prod` (clean) -> `launchctl kickstart -k
gui/$UID/com.proxywar.beta` -> ready on `:8788` in <1s -> `launchctl
kickstart -k gui/$UID/com.proxywar.league-mirror` (fresh log confirms the
full new backfill pipeline ran: recap re-curation, match-state-series x3,
director-cut plan, site regeneration). Post-deploy smoke: homepage (200),
`/league` (200), a real match page (200, correct title), a real premiere
page (200, real content) — all against `https://beta.proxywar.xyz`
externally. `com.proxywar.platform` and `com.proxywar.betautocycle` were
not restarted (league-beta-only scope, per task). Rollback point: the
release-candidate worktree's pre-redeploy HEAD was `b9d389be0`
(PID `52367`, healthy at the time); to roll back, `git checkout --detach
b9d389be0` in that worktree, `npm ci && npm run build-prod`, then
`launchctl kickstart -k gui/$UID/com.proxywar.beta` again.

## Addendum — Season Zero Activation (same pass, follow-up turn)

Executed after the Phase 0/1 report above. Final HEAD for this addendum:
`66e9403db` (pushed, deployed onto the beta-serving worktree, verified live
externally). No `src/` code changed in this addendum — only operational CLI
state (`resources/season/seasons.json`, tracked) and two docs files.

### Season and event

- **Season**: `season_season-zero` (slug `season-zero`), created via
  `season:create` and walked to `active` via `season:activate`.
  `startDate: 2026-08-01`, `endDate: 2026-09-12` (a bounded six-week
  programme, no championship points language). File:
  `resources/season/seasons.json`.
- **Featured Event**: `feat_21d64517e31863134746` — "Calc wins — Round 1119
  on Pangaea", a real hosted Coworld league episode
  (`ereq_460ea72c-8072-4c73-87e3-711b3cbc6952`), composite score 90.42/100,
  the strongest candidate `feature:candidates` currently ranks with **zero**
  unmapped participants (all 12 resolve `agentId`+`agentVersionId` via the
  `buildParticipants` standings fix from `6618da9ad`, the prior turn's
  archive-lane bug fix). Promoted into the FeaturedMatch store via
  `mutateFeaturedMatchStore` (the same sanctioned, lock-protected primitive
  the production CLIs themselves use — `feature:candidates` stays read-only
  by design, and no `premiere:promote` CLI exists yet; see "CLI gap" below).
  Packaged with `npm run premiere:package -- --featured=<id>`, then
  `--validate`: **`isPubliclyPromotable: true`** (one non-blocking prose
  warning about the round number "1119" lacking a matching
  `reasonToWatch.claims[]` entry — cosmetic, not a gate failure).
- **Schedule**: `season:add-event --season=season_season-zero
  --featured=feat_21d64517e31863134746 --scheduled-at=2026-08-03T18:00:00.000Z`
  (~47h lead from the moment of scheduling, a Monday-evening UTC slot
  establishing the weekly cadence; `SeasonEventSlot.scheduledAt` is the
  season programme's OWN calendar entry, independent of
  `FeaturedMatch.scheduledAt` — see `SeasonSchemas.ts`'s own doc). Confirmed
  in `resources/season/seasons.json`'s `eventSlots[0]`. Standalone
  `premiere:validate` (whole-store schedule-consistency check) also passes:
  `premiere:validate — ok (1 record(s) checked)`.
- **Why archive-lane, not premiere-lane**: the premiere queue was genuinely
  empty at execution time (`premiere:candidates --json` → `candidates: []`;
  `league-mirror.log` confirms `idle: no completed unpremiered round` for
  15+ consecutive minutes, the prior sealed item having already been
  revealed/consumed at `18:49:19Z`). Topping the queue up requires either
  waiting on the reactive `generate-premiere-queue.sh` loop's own cadence or
  manually forcing it, which is explicitly **operator-gated** in its own
  header doc ("every successful attempt is a real, billed Coworld episode")
  — not triggered here without operator authorization. Separately, code
  inspection found the premiere lane has its own, deeper, pre-existing gap:
  `premiere-candidates.ts` always sets `participants: []` by design (never
  opens the embargoed `bundle.source.json`), and neither `premiere-package.ts`
  nor `premiere-publish.ts` ever populates it afterward — so
  `isPubliclyPromotable`'s unconditional `match.participants.length === 0`
  check (`EventPackageGate.ts:83`) means **a premiere-lane record can never
  pass the public-promotion gate today, regardless of how far through
  package/validate/schedule/publish it's taken.** This is the same bug
  class as the archive-lane one already fixed, just unfixed on the other
  lane — flagged here as a real, separate finding, not fixed in this pass
  (no real premiere candidate exists right now to verify a fix against, and
  it needs its own dedicated investigation + test pass, same as the
  archive-lane fix did).
- **CLI gap, restated precisely**: there is no `premiere:promote`/
  `feature:promote` operator CLI that turns a ranked `feature:candidates`
  result into a persisted `FeaturedMatch` record — this pass used the
  library's own sanctioned `mutateFeaturedMatchStore` primitive directly
  (documented in the commit `2eaded111`) as a stand-in. A real CLI wrapping
  exactly that call (validate against `FeaturedMatchSchema`, refuse a
  duplicate/conflicting `matchId`, same flag conventions as the other five
  `premiere:*`/`season:*` verbs) is the honest permanent fix and should be
  a follow-up task.

### Live gate verification

- **Read model**: `https://beta.proxywar.xyz/ai-league-runs/league/read-model.json`
  (externally curled, 200) carries `seasons[0]` with the full event slot,
  and `featuredMatches[0]` (`feat_21d64517e31863134746`) with
  `isPubliclyPromotable: true`, a real `result`/`placements` block, and
  real `reasonToWatch` claims — generated by a live-triggered
  `league-mirror` cycle (`generatedAt: 2026-08-01T19:12:46.467Z`).
- **Homepage hero**, live on `beta.proxywar.xyz`, screenshotted both
  desktop (1440px) and mobile (390px):
  `docs/verification-evidence/season-zero-activation/homepage-hero-desktop-1440.webp`,
  `.../homepage-hero-mobile-390-top.webp`,
  `.../homepage-hero-mobile-390-schedule.webp`. Visible, real content:
  a "SEASON ZERO SCHEDULE / 8/1/2026 – 9/12/2026" panel showing
  "8/3/2026 Calc wins — Round 1119 on Pangaea" (the exact scheduled
  event, real title), and the top hero card's "Next expected event
  window: 8/3/2026, 7:00:00 PM" (18:00 UTC in local British Summer Time —
  matches the scheduled slot exactly). The top hero CARD ITSELF still
  shows "RECENT BATTLE" (the most recently completed match, World Round
  1120) with the explicit caption "No premiere is scheduled right now.
  This is the most recently completed match with a full replay
  available." — correct, honest behavior: there is no LIVE embargoed
  premiere right now (confirmed above), so the fallback hero is exactly
  what the product is supposed to show, while the season schedule strip
  and "next expected event" callout correctly surface the real, gated,
  future Featured Event alongside it.
- **Non-promotable System-B premieres stay demoted**: no anonymous
  premiere is currently live (`read-model.json`'s `premieres.live: null`),
  so a visual "still demoted while live" screenshot isn't possible right
  now — verified structurally instead: `premieres.latest` (the most
  recently revealed one, `prem_89156f725b6402e3cbf79b2a`) carries only its
  five documented spoiler-safe fields (`premiereId`, `roundNumber`,
  `mapLabel`, `revealedAt`, `href`) in the live production read model —
  no title, no roster, no reason-to-watch — confirming the type-level
  guarantee `EventPackageGate.ts`'s class doc describes is intact in
  today's actual served data, not just in the source. `featuredMatches[]`
  in the same live read model contains exactly one entry: the genuinely
  promotable one created above — nothing else is masquerading as a
  Featured Event.
- **League-mirror cycle** (part (d)): kickstarted
  (`launchctl kickstart -k gui/$UID/com.proxywar.league-mirror`) after
  `season:add-event`; log confirms a fresh run picked up the new season +
  event and regenerated `read-model.json`/`index.html` (`site updated:
  .../league/index.html (18 standings, 9 battles)`), externally verified
  above.

### Platform-origin verdict — genuine P0, not this session's breakage, NOT fixed here (read-only per scope)

Investigated the "still crashlooping?" question from the prior turn's
activity log. **Verdict: it is NOT currently crash-looping** — `launchctl
print gui/$UID/com.proxywar.platform` shows `state = running`, and its
process chain (`zsh` PID 45120 → `npx` PID 45144 → the real `tsx`-loaded
`node` server PID 45148, confirmed via `ps -o ppid` that 45144 is a direct
child of 45120) has been continuously alive and stable for **23h48m**
(`lstart: Fri Jul 31 20:12:36 2026`), predating every commit and every
action in this entire task by nearly a full day — this is not something
either of this task's two turns caused. `launchctl list`'s `-9` exit-status
column is a stale historical value from a PREVIOUS invocation before this
current 23h48m-stable run started, not live behavior (`runs = 76`, `forks =
15` are cumulative counters since the plist was first loaded, not recent
churn).

**But it IS a real, severe gap — just a different one than "crashing"**:
the live process's code, `/Users/claude/.proxywar-deploy/platform-origin`
(`git rev-parse HEAD` = `8ca7465`), is **410 commits behind**
`claude/product-overhaul`'s tip (`git log --oneline HEAD..<dev-tip> | wc -l`
= 410 in that deploy dir), and specifically predates commit `9c6756f60`
("feat(identity): Season Zero Phase 3+6 — real Builder/Agent claim
workflow + builder improvement loop") — confirmed via `git merge-base
--is-ancestor 9c6756f60 HEAD` returning false in that checkout. Concretely:
the real claim-workflow HTTP routes
(`createPlatformBuilderClaimRouter`/`createPlatformBuilderEditRouter`/
`createPlatformVersionReleaseRouter`, `ai-agent-demo-server.ts` lines
~1908–1970) are gated behind `if (platformEnabled)` where `platformEnabled
= envFlag("PROXYWAR_PLATFORM_ENABLED")` — **only ever true on the platform
launchd job** (`start-proxywar-platform.zsh` sets it; beta's env file does
not). `/claim` returns HTTP 200 on BOTH origins because the SPA-shell route
(`app.get("/claim", ...)`) is unconditional on every instance of
`ai-agent-demo-server.ts` regardless of mode — but the actual claim-flow
backend API is architecturally reachable ONLY through platform-origin, and
that origin is running code from before the claim workflow existed at all.
**Net effect: the real Builder/Agent claim flow is not functional anywhere
in production right now** — not because anything crashed, but because the
one process authorized to serve it has not been redeployed since before it
was built.

**Disposition: read-only, reported, not touched.** This predates this
session's entire activity (by ~24h at minimum) and is squarely outside
"our breakage." A platform-origin redeploy is a materially bigger, riskier
action than anything else in this pass — 410 commits of drift on the sole
account/session/OAuth authority (GitHub sign-in, HMAC-signed session
cookies, account records) needs its own dedicated review pass (diff the
auth/session/OAuth-touching commits specifically, check for
config/env/schema drift in `platformPrivateStateRoot`'s stores across that
range, stage the restart with an explicit rollback plan) — not a
side-effect of a Season Zero activation task. **Recommended next step for
the operator**: a dedicated "platform-origin redeploy" task, scoped and
reviewed the same way this task's own beta redeploy was, before the
identity milestone can be considered live.

## Addendum 2 — Final deploy wave + re-activation (same pass, second follow-up)

Final dev-branch HEAD for this addendum: `c18fff859` (pushed). Beta
redeployed onto `a5f6fbe2e` (one commit behind dev HEAD — the gap is only
the docs-only round2-screenshots commit, no runtime effect).

### 1. Validate + deploy

Full matrix at `cb53c3e6d` (the tip named in this wave's brief), all green:
`tsc` 0 errors; `lint` 0 errors/113 warnings (unchanged, nullish-coalescing
only); `npm test` 417+236 files, 4962+2769 tests passed, 3 todo, 0 failed;
`npm run test:e2e` 27/27; `build-prod` clean. Pushed
(`c79e56ee9..cb53c3e6d`, fast-forward, no force). Deployed: rollback point
recorded (release-candidate worktree pre-redeploy HEAD `2eaded111`, PID
`63533`, healthy) → fetch + `checkout --detach cb53c3e6d` → `npm ci` → `tsc`
clean → `build-prod` clean (includes the F9 asset-manifest shell rebuild)
→ `launchctl kickstart -k gui/$UID/com.proxywar.beta` (PID `63533` ->
`75280`) → ready on `:8788` in 1s, confirmed matching SHA via `lsof`
cwd+`git rev-parse HEAD` → `launchctl kickstart -k
gui/$UID/com.proxywar.league-mirror`, log confirms a fresh cycle ran.
**Not touched**: `com.proxywar.platform` (PID/exit-status unchanged from
Addendum 1's investigation) and `com.proxywar.betautocycle` (PID `383`
unchanged) — `bet.proxywar.xyz/league` externally verified 200 throughout.
Per this wave's brief, bet-origin trails the tip at `ce0105de7` and can
ride its next independent refresh — not this pass's job.

### 2. Regeneration verification (4 manual league-mirror cycles, budget-boosted)

The default `--match-narrative-budget` is 1/cycle; clearing the full
backlog of pre-fix `decisive-moments.json` artifacts (schemaVersion 1,
several carrying the leaked LLM-provider error string) needed a larger
one-off budget to finish inside a bounded number of cycles — used
`--match-narrative-budget 20`, then `40`, then `150` (101 total run
directories; the backfill scan order is deterministic ascending-by-name,
i.e. chronological, so a budget smaller than the full backlog's rank
position never reaches it in one pass) across 4 total manual cycles
(1 auto + 3 boosted-budget). **Final state: 80/80 `decisive-moments.json`
files at `schemaVersion: 2`, zero containing any `plan-err`/`HTTP
4xx`/`HTTP 5xx`/`Invalid API Key` text anywhere** (verified by scanning
every file's `statedReason` fields directly, not sampling).

- **Recap v5 features, live on real production data**: terminal-elimination
  compression — 101/101 fresh `match-recap.json` files carry a single
  `"Final turn: N agents eliminated as the match ends."` beat instead of N
  individual elimination beats (e.g. `"Final turn: 9 agents eliminated as
  the match ends."`). Betrayal-repeat aggregation — 40 examples found
  across fresh recaps, e.g. `"Auri and Ron SWGY break their alliance again
  (3 more times through turn 12300, most recently the 4th time)."`
- **Decisive-moments v2, F5 gap check — cured, with an example**: moment
  type distribution across all 80 fresh files: `lead_change` 139
  occurrences in 70/80 matches (87.5%), `final_confrontation` 56 in 56/80
  (70%), `alliance_betrayal` 109, `territorial_swing` 54, `reversal` 30 —
  no longer systematically absent. Concrete example carrying both types in
  one match:
  `league-coworld-2026-08-01T18-11-29-043Z-2df8b2f2`'s
  `decisive-moments.json` includes both a `lead_change` and a
  `final_confrontation` moment. **Yes, the F5 gap is cured** on freshly
  generated real-production artifacts.
- **Provisional identities live**: `agt_james-botts` (and `agt_jordan`)
  registered in `resources/identity/agents.json` with a real generated
  emblem (`geometric-svg-v1`, `resources/identity/emblems/agt_james-botts.svg`,
  1140 bytes on disk). Live: `GET /agent/james-botts` → 200; the live
  read-model's `agents[]` entry for James Botts shows `registered: true`
  with a real inline `emblemSvg` (not a placeholder/fallback), a resolved
  `standing` (rank 16) and `activeVersion`/`provenance` (policy label
  `jamesboggs-warlord:v1`). Standings check: `GET
  /ai-league-runs/league/read-model.json`'s `agents[]` — **0/19 entries
  unregistered, 0/19 carrying a `provisionalSlug`** (i.e. zero anonymous
  cards) as of this pass.

### 3. Re-activation of the schedule

Confirmed the prior slot's episode (`feat_21d64517e31863134746`) correctly
went `isPubliclyPromotable: false` after aging out (its `EventPackage` was
cleared — `subtitle`/`reasonToWatch`/`canonicalMatchUrl` all reverted to
null in the live read model — and its title reverted to the spoiler-neutral
form). Fresh pipeline, using the new sanctioned `feature:promote` CLI (no
hand-rolled store writes this time):

1. `feature:candidates --json` → strongest current candidate:
   `ereq_253e5a33-24c3-45f7-9119-66b3013ffd19`, composite 90.67, 12/12
   participants resolved.
2. `feature:promote --episode=ereq_253e5a33-...` → `feat_4d20f6550c6c8d8e83bc`
   ("12-player free-for-all — Round 1122 on World"), idempotent (re-run
   confirmed `wasAlreadyPromoted: true`, same matchId reused).
3. `premiere:package --featured=feat_4d20f6550c6c8d8e83bc` → title **"12-way
   battle — World"** — spoiler-neutral by construction, confirmed no winner
   name (the real winner is Auri; "Auri" does not appear anywhere in the
   title).
4. `--validate` → `isPubliclyPromotable: true`. Standalone `premiere:validate`
   → `ok (2 record(s) checked)`.
5. `season:add-event --season=season_season-zero
   --featured=feat_4d20f6550c6c8d8e83bc --scheduled-at=2026-08-03T18:00:00.000Z`
   (same weekly slot as before, still ≥24h out at scheduling time).
6. **Found and fixed a real display gap while doing this**: `season:add-event`
   has no counterpart removal command, and `LobbyPage.ts`'s
   `renderSeasonSchedule` takes every `eventSlots` entry unfiltered by
   `isPubliclyPromotable` — re-adding without removing the aged-out slot
   would have rendered TWO entries at the same date. No `season:remove-event`
   CLI exists (a real gap, noted here for a follow-up), so dropped the
   stale slot via the sanctioned `loadSeasonRegistry`/`saveSeasonRegistry` +
   `SeasonSchema`-validated path directly (`resources/season/seasons.json`
   now carries exactly one `eventSlots` entry).
7. Mirror cycle re-run; live read model confirmed:
   `featuredMatches[].isPubliclyPromotable: true` for the new match,
   `seasons[0].eventSlots` containing exactly the one new entry.

**Live verification, screenshots**:
`docs/verification-evidence/season-zero-activation/round2/homepage-desktop-1440.webp`,
`.../homepage-mobile-390.webp`. Both show a single "SEASON ZERO SCHEDULE"
entry: **"Featured spotlight — 8/3/2026  12-player free-for-all — Round
1122 on World"** with a **"Played 8/1/2026"** note beneath it — exactly the
"Featured spotlight" lane-presentation + played-date the brief specified
(`isArchiveSpotlight` branch of `renderSeasonSchedule`, confirmed live, not
just in source).

### 4. Full live smoke

All against `https://beta.proxywar.xyz` externally unless noted:

| Check | Result |
| --- | --- |
| Core routes `/`, `/watch`, `/league`, `/build`, `/about`, `/agents`, `/builders` | all 200 |
| Promoted match page `/match/feat_4d20f6550c6c8d8e83bc` | 200 |
| Episode-id match page `/match/ereq_253e5a33-...` — decisive moments/recap content | 200; RECAP section shows the terminal-elimination + repeat-betrayal beats live; direct file check of this exact match's `decisive-moments.json` confirms `schemaVersion: 2`, no leaked error text |
| Storylines capped (F8) | live page shows 5 explicit head-to-head lines + `"+61 more rivalries with prior history, not shown"` — capped, not a raw dump |
| Degraded-turns tooltip (F7) | `"978 recovered turns (41%)"` span carries a real `title` attribute: `"Turns played by a safe fallback instead of an agent's own decision — most often the agent reporting its own planner degraded; less often an error, an illegal move, or a timeout."` |
| `/agent/james-botts` | 200 |
| Analytics ingest | `POST /api/analytics/events` → 204. First attempt used a malformed payload (missing the batch-level `schemaVersion` field `AnalyticsBatchSchema` requires) and was silently dropped — matches the route's own documented "always 204 regardless of whether the batch validated" contract; a corrected payload advanced `page_viewed`'s live UTC-day aggregate count 45 → 46 in `analytics-aggregates.json`, confirmed by direct before/after read |
| Flag asset (F9) | homepage's injected `window.ASSET_MANIFEST` resolved a real hashed flag URL (`/_assets/flags/1_Airgialla.8ff4edcb40cb.svg`) → 200; hashed JS/CSS bundle URLs also 200 |
| `bet.proxywar.xyz/league` | 200, untouched throughout this pass |

### 5. Two operator-pending items

1. **Main promotion decision** — unchanged since `c79e56ee9`
   (main-promote's review): `origin/main` is untouched at `6f366d8ed`; the
   operator must choose among (a) promote as-is (wagering surface already
   public on the branch ref, would become default-branch-visible), (b)
   build a wagering-free promotion branch (a real edit/rebase job — several
   files hold inline conditional wagering branches rather than a cleanly
   separable module), or (c) leave `main` alone (every live service already
   runs `claude/product-overhaul`, never `main`). Not re-litigated or
   re-decided in this pass — still pending.
2. **Claim queue awaiting first real claims** — directly explained by
   Addendum 1's platform-origin finding: the Builder/Agent claim HTTP API
   (`createPlatformBuilderClaimRouter` et al.) is mounted only when
   `PROXYWAR_PLATFORM_ENABLED` is set, true only for the platform-origin
   launchd job — which is still running code from before commit `9c6756f60`
   (the claim workflow itself) at last check. `resolveBuilderClaimStateRoot`
   nests under the platform's own private state root, and no claim files
   exist there yet — consistent with "the surface that would receive a
   real claim has not been redeployed," not "claims were submitted and are
   stuck." Resolving this is the same platform-origin redeploy flagged as
   its own dedicated follow-up task in Addendum 1.

## Addendum 3 — Test-infra hardening + consolidated four-workstream deploy wave

Deployed SHA: `ab606af88` (rollback point: `066f8807c`, the previous
`origin/claude/product-overhaul` tip, recorded before push). This wave
consolidates four independent workstreams that landed on the shared branch
concurrently, validated and deployed together as one tip.

### 1. Wave contents

- **Test-infra hardening** (`6c8d81935`): root-caused and fixed
  `AnalyticsServerIntegration.test.ts`'s order-dependence (shared fixed port
  + a `stopServer()` that never waited for real process exit); hardened
  `tests/e2e/support/CdpBrowser.ts` against the 28-instance/8+-hour headless
  Chrome leak (random 500-wide port range → genuinely OS-reserved port;
  added a startup sweep + `exit`/`SIGINT`/`SIGTERM` handlers matched ONLY on
  the `pw-e2e-chrome-` `--user-data-dir` prefix); fixed a real bug in
  `FixtureServer.ts` (`stop()` looking for the legacy non-port-scoped
  pidfile, silently never stopping its own origin); added
  `scripts/fixtures/clean.sh` + `npm run fixtures:clean`. Full writeup and
  evidence in `docs/project-state/known-problems.md`'s "2026-08-01 Test-Infra
  Hardening" section (gitignored, canonical-checkout-local per
  working-agreements — not duplicated here beyond this summary).
- **Agent-protocol reason/fallback fix** (`b96a53798`, `00dde1ca7`,
  `ab606af88` — the `LlmAgentBrain`/`ExternalHttpAgentBrain`/
  `ExternalRelayAgentBrain` family): `AgentDecision.reason` is now
  `string | null`. On a genuine provider/parse/endpoint/managed-relay
  failure, the fallback path no longer glues the raw error text together
  with the substituted brain's own reason into one string (the P0 fix from
  the 2026-08-01 known-problems entry, "LLM-provider error strings leaking
  into public 'stated reason' text") — `reason` becomes `null` and the
  failure detail moves to `metadata.fallbackReason`, a field never shown to
  viewers. Every reader of `AgentDecision.reason` was audited for the new
  nullability (per the reporting sibling).
- **Season Zero operational gaps** (`a67c14a4d`): three new CLI
  capabilities — `season:remove-event` (the counterpart `season:add-event`
  was missing, previously worked around by hand-calling
  `loadSeasonRegistry`/`saveSeasonRegistry` directly, per Addendum 2 §3.6),
  `season:program-week`, and a pre-reveal Director Cut duration estimate.
- **Mobile replay fix** (`15ae0d9b0`, P2-F10 + P2-F11): portrait letterbox
  overzoom fix (the map used to render in roughly the top ~40% of a
  portrait viewport; the client-side sizing bug is fixed) and spectator DOM
  pruning — see §4 below for the corrected, honest scope of what P2-F11
  actually prunes.

### 2. Validate + deploy

Full matrix at the consolidated tip `ab606af88`, all green: `tsc --noEmit`
0 errors; `lint` 0 errors / 113 pre-existing warnings (nullish-coalescing
only, unchanged); `npm test` 418+236 files, 5020+2787 tests passed (3 todo
in pass 1), 0 failed, both passes; `npm run test:e2e` 27/27 passed on the
**clean** consolidated tree (live-premiere block ran for real — no skip
env needed — ~211s including the two 60s checkpoint-pause windows);
`build-prod` clean. Pushed `066f8807c..ab606af88` (fast-forward, no
force). Deployed: rollback point recorded (`066f8807c`, prior
`origin/claude/product-overhaul` tip) → fetched + `checkout --detach
ab606af88` into the release-candidate worktree → `npm ci` (697 packages,
4s) → `build-prod` clean → `deploy/mac/proxywar-beta-launchd-restart.mjs
--ready-url=http://127.0.0.1:8788/league` (dry-run passed, then real:
PID `75280` → `21208`, ready, ~9s) → `launchctl kickstart -k
gui/$UID/com.proxywar.league-mirror`, confirmed via a fresh
`league-mirror.log` entry ~24s later: `site updated: .../league/index.html
(18 standings, 12 battles)`. **Not touched**: `com.proxywar.platform` and
`com.proxywar.betautocycle` — `bet.proxywar.xyz/league` externally
verified 200 throughout, before and after this wave's restart.

### 3. Live smoke — core routes, match page, portrait replay

| Check | Result |
| --- | --- |
| Core routes `beta.proxywar.xyz/league`, `127.0.0.1:8788/{league,watch,/,build}` | all 200 |
| Match page `/match/dff4afe0` (real episode from the live `data.json`) | 200 |
| `bet.proxywar.xyz/league` | 200, untouched by this wave |
| Portrait replay (390×844, real production replay, real browser session) | canvas is full-viewport (390×844, 100% height, `transform:none`) — refutes the old ~40%-band regression by construction (a 40% band would show a much shorter canvas/parent height); the "Fit the whole map" whole-board control (P2-F10) is present with that exact `aria-label`/`title`. The precise in-canvas rendered-map pixel-fill percentage (as opposed to the canvas element's own DOM size, which is always full-viewport) was not separately instrumented — a WebGL/2D-canvas rendering-internals detail, not a DOM/CSS property. |

### 4. P2-F11 DOM pruning — corrected scope (do not cite the local-baseline number as a production result)

An earlier draft of this record cited a "94.7% / 273-node" reduction
figure for the live replay route. **That figure is wrong for this
context and must not be repeated**: it came from a local game-shell-scope
baseline that never mounted `AiLeagueReplayOverlay` at all, not from the
production replay route.

What P2-F11 actually does, confirmed on the real production replay route:
it prunes six dead-chrome subtrees — the main-menu area, the host-lobby
modal, the store modal, both nav bars, and the game-mode selector — down
to 0/near-0 nodes each. Those subtrees are genuinely gone from the replay
route's DOM.

The live replay route's **full document** remains **~4,207–4,260 nodes**
(my own direct measurement on a real post-restart replay: 3,789 — within
that same range; the spread reflects how far into playback the decision
ticker has grown at measurement time), dominated by the **load-bearing**
spectator overlay itself (~3,872 nodes: ~1,957 decision-ticker rows +
~527 per-entry buttons), which **grows during playback** — pruning it
further was never P2-F11's scope; it is live content, not dead chrome.

**Follow-up identified, not blocking this deploy, dispatched separately**:
window/cap the decision ticker and its per-entry action buttons on the
replay route so the full-document count stops growing unbounded across a
long match.

### 5. Reason/fallback shape — live verification

Newest post-deploy episodes (`league-coworld-...-e6a34945`,
`...-7200a150`, both starting 45s–2min after the restart) parse cleanly as
JSONL with zero occurrences of the old folded-string leak pattern
("LLM decision rejected (...); fallback: ..." / "Agent brain failed
(...); fallback: ..."). Both DO contain real `fallbackUsed: true`
decisions (630 and 576 respectively), but every one carries a
non-null `reason` — a genuine rule-brain-authored string (e.g.
`"rul:atk"`) — i.e. ordinary fallback substitutions, not the
provider/parse FAILURE case the fix's `reason: null` +
`metadata.fallbackReason` shape targets. Scanned all 101 episode
artifacts ever recorded on this deployment (full history): **zero
`reason: null` records exist anywhere, live or historical** — the
external-http brain endpoint has apparently never actually failed on this
deployment, so the null-reason branch has never fired for a real decision.
Verified the branch is tolerated regardless: loaded the newest post-deploy
episode's replay in a real browser against production, expanded the
decision log overlay (10 decisions rendered, including a real
`fallbackUsed` record), zero console/page errors, no error banner —
the client's `reason: string | null` handling
(`decision.reason ?? "(no stated reason — fallback decision)"` in
`AiLeagueReplayOverlay.ts`) is live and does not break the overlay, even
though no live record exercised the null branch specifically.

### 6. `season:status` — new per-slot health line, live

Run read-only from the release-candidate checkout with production env
sourced per the runbook pattern (`set -a; source
~/.proxywar/proxywar-beta.env; set +a; npm run --silent season:status`):

```
season_season-zero — "Season Zero" [active] 2026-08-01..2026-09-12
  event slots: 1
    - feat_4d20f6550c6c8d8e83bc @ 2026-08-03T18:00:00.000Z
      health: promotable: true, aired: true, aged-out: false
  archive matches: 0
  standings snapshot refs: 0
```

The Aug-3 slot renders the new per-slot health line, computed live
against the production registry (`resources/season/seasons.json`, tracked
and deployed in the checkout) and the production featured-match state
(resolved via the sourced `PROXYWAR_*` env vars). The reported state is
internally consistent — a slot that has aired and is promotable cannot
also be aged-out, and `computeSlotHealth` enforces exactly that.

## Addendum 4 — Main promotion attempt 2026-08-02: operator decision recorded, execution blocked on topology

**Operator decision (2026-08-02), quoted verbatim**: "Betting is back on the
menu. Promote as is." This is option (a) from the pending-decision list
above: it explicitly lifts the 2026-07-27 "zero wagering code on `main`"
constraint recorded in this section, and authorizes promoting
`claude/product-overhaul` to `origin/main` **including** the full wagering
surface inventoried in "Promotion review completed 2026-08-01" above (the
86 tracked files / 19,279 LOC, structurally flag-gated, `PROXYWAR_WAGERING_ENABLED`
off by default). This decision is recorded and stands regardless of the
topology finding below — nothing below is a wagering objection.

**Promotion target**: `2a8f201ca4504716d1224794ef6c053e5e5cf643` (the
`origin/claude/product-overhaul` tip at task dispatch; the shared worktree's
live HEAD had moved 2 commits further, `7bc8bc7541d5`, by execution time —
two sibling QA sessions committing concurrently — this task pinned and
evaluated only the fixed target SHA, never the moving tip, per instruction).

### Step 1 — topology check: FAILED, not a fast-forward

Re-verifying the ancestor relationship this doc's earlier "Main
reconciliation" section assumed found it **no longer holds**:
`git merge-base --is-ancestor origin/main 2a8f201ca` is **false**.
`git rev-list --left-right --count origin/main...2a8f201ca` = **11 ahead,
379 behind** (`origin/main` at `913347b07d010741f814fa385e596fc1499e0d6f` —
confirmed live on `github.com/0xNad/ProxyWar/commits/main`, not just a local
fetch artifact; merge-base with the target is `6f366d8ed3cb814b61a0c73ac4be6ca1e60ef961`,
the exact SHA this doc's 2026-08-01 review recorded as `origin/main`'s
then-current tip). A live `git push --dry-run origin 2a8f201ca:main` was
rejected: `! [rejected] ... (non-fast-forward)`.

Root cause: 11 commits landed directly on `origin/main` between
2026-08-01T23:19 and 2026-08-02T03:24 (all authored and committed by a
separate, concurrent `Claude <claude@Mini-di-Claude.home>` session), none
of which exist anywhere in `claude/product-overhaul`'s history (checked by
commit-message search across the full branch log; confirmed by the dry-run
rejection). They are core/coworld/agent performance and release-gate work —
`perf(core): compute tile coordinates arithmetically, drop the LUT triple`,
`perf(agents): columnar spawn-candidate scan, allocation-free spawn-site
check`, `perf(coworld): run the episode on ONE map dataset, not three`,
`build(coworld): memory-regression gate in front of every image build`,
`docs(core): fix stale equivalence-test path...`, `perf(agents):
primary-only turn retention...`, `feat(league): expand the 12P rotation to
eight maps`, `gate(coworld): assert the late-window slope; ship as 0.1.17`,
`coworld: hydrate 0.1.17 release manifest...`, plus `fix(coworld): bound
World 12P episode memory...` and `starter(llm): route hosted Bedrock via
the platform sidecar endpoint` — a separate, apparently legitimate
workstream operating directly against `main`, unrelated to and unaware of
this promotion task.

Per the documented procedure ("if it cannot fast-forward, STOP and report,
do not merge/rebase on your own"): **execution stopped here.** No tag was
cut, `origin/main` was not touched, and `claude/product-overhaul` was not
pushed to `main`. Steps 3-5 (rollback tag, fast-forward push, public-state
verification) were **not executed**.

### Step 2 — review posture and hygiene: completed (informational; no push occurred)

Waves since the 2026-08-01 full public-surface review (reviewed tip
`c66f1d754`): **28 commits** to `2a8f201ca`, each validated and deployed per
this doc's own trail — the two post-review hygiene fixes (`681b54e81`,
`bb6280483`), the consolidated validation matrix at `c9a224eea` (0
tsc/lint errors, 4883 tests, e2e 27/27), Addendum 1 (`66e9403db`, Season
Zero activation, no `src/` changes), Addendum 2 (`cb53c3e6d`, 4962+2769
tests, e2e 27/27), Addendum 3 (`ab606af88`, 5020+2787 tests across 418+236
files, e2e 27/27 — the exact source of this task's cited "654 files /
7,800+ tests" figure), and 10 further commits beyond Addendum 3 recorded in
`RUNBOOK.md` §17 (bet-origin reconciliation/redeploy) and
`docs/BETTING_HANDOFF.md`, plus four self-verified replay-perf follow-ups
(`673440670`, `3bb128138`, `86e9f33ea`, and `2a8f201ca` itself — each
commit message carries its own full-suite count, tsc/lint-clean
confirmation, and real-browser verification; the suite grew to 5036+2787
passing by the final commit). No new full-matrix run was executed by this
task, since no promotion happened; the cited counts are the branch's own
most recent self-reported figures, not independently re-run here.

Hygiene greps across the full merge-base-to-target diff (707 files
changed, +256,160/-3,804): **no credentials, API keys, tokens, private-key
material, or real (non-fixture) email addresses found** — checked
`ghp_`/`gho_`/`AKIA`/`sk-`/`xox*`/`AIza`/PEM-header patterns and email
addresses; only `nope@example.com` and pre-existing test-fixture addresses
matched. No `.env*` files touched.

Two real hygiene findings, neither new to this wave (both predate
2026-08-01) and neither a secret/credential leak, but worth recording since
this task's own acceptance bar named them directly:

1. `.gitignore` line 21 (`docs/project-state/`) marks that whole directory
   ignored, yet **5 files under `docs/project-state/` are tracked** at the
   target SHA (`2026-07-20-proxywar-premiere-loop-product-spec.md`,
   `-replay-premiere-admission-command.md`,
   `-replay-premiere-implementation-evidence.md`,
   `-replay-premiere-secret-recovery.md`,
   `2026-07-24-clips-release-evidence.md` — added before the 2026-08-01
   review in `44b97834e`/`82cc1bd67`, not flagged by that review's hygiene
   pass, which covered `.omp/` and one hardcoded path but not this). Read
   all 5 directly: no secrets or credentials in their content (the
   "secret-recovery" one is a fail-closed HMAC-key-file incident procedure
   that explicitly never records key bytes) — but they would be the first
   `docs/project-state/*` files ever to reach `origin/main` (`origin/main`
   currently tracks zero files under that path), which conflicts with this
   task's own acceptance bar ("no gitignored local files leaked — the
   project-state ledgers must NOT appear") and the directory's own
   `.gitignore` intent.
2. `deploy/mac/com.proxywar.platform.plist.example` and several docs
   (`RUNBOOK.md`, `docs/BETTING_HANDOFF.md`, this file) contain literal
   `/Users/claude/...` operator home-path references — not credentials,
   but real machine-path/username disclosure that `origin/main` currently
   has none of (0 occurrences today, confirmed via `git grep`).

### Disposition

**Not promoted this attempt.** The operator's wagering decision is
accepted and recorded; the blocker is purely topological. Recommended next
step for whoever holds push authority: reconcile `origin/main`'s 11 stray
commits with `claude/product-overhaul` (rebase the promotion tip onto the
current `main` tip, or coordinate with the session that pushed them to
pause first) before re-attempting a clean fast-forward. Separately, decide
whether the 5 tracked `docs/project-state/` files and the `/Users/claude/...`
path references in tracked docs/examples are acceptable for the public
default branch as-is, or should be trimmed before the next promotion
attempt. No rollback tag was created (there is nothing to roll back from —
`origin/main` was never touched).

### Hygiene fixes resolved same session (2026-08-02, follow-up)

Per operator instruction, folded the mechanical parts of both findings
above into this branch directly:

- **Tracked `docs/project-state/` files**: `git rm --cached` on all 5
  (history preserved — old commits still carry the blobs; only future
  commits stop tracking them, matching `.gitignore`'s existing
  `docs/project-state/` rule and origin/main's existing zero-file state
  under that path).
- **`/Users/claude` path generalization**: fixed
  `deploy/mac/com.proxywar.platform.plist.example` (4 occurrences) to
  `/Users/YOUR_USER`, matching every sibling `.plist.example` in
  `deploy/mac/` (`beta`, `beta-backup`, `cloudflared`, `premiere-loop` all
  already used that placeholder — `platform.plist.example` was the sole
  outlier). Fixed `docs/BETTING_HANDOFF.md`'s "canonical checkout lives
  at" sentence to `~/Documents/proxywar_main`.
- **Deliberately NOT changed**: the remaining `/Users/claude` references
  in `RUNBOOK.md` (a literal quoted real boot-log block, "Real boot log
  observed:") and in this doc's own "Deployed state" / verification
  sections above (real cwd of the live deployed process, the real
  `PROXYWAR_ARTIFACTS_ROOT` path used in a real verification run, the real
  platform-origin deploy path found live) — these are factual records of
  what was actually run/observed, not generic path documentation;
  rewriting them to a placeholder would misrepresent the verification
  evidence itself. Flagging this distinction rather than silently leaving
  them — reversing this call is the operator's to make, not a default.

### Promotion EXECUTED 2026-08-02 — `origin/main` fast-forwarded, GO received

**Operator GO, quoted verbatim**: "GO for the main push. Promote exactly
756562c53 (your validated merge tip — do NOT chase the moving branch tip;
siblings have landed newer commits that will ride the next promotion
cycle)." This confirms and executes the "Promote as is" decision recorded
above — the topology blocker from Addendum 4's Step 1 was independently
resolved earlier the same day (`origin/main`'s 11-then-12 stray commits
were merged into `claude/product-overhaul`, not rebased away; see the
merge/forward-merge/hygiene commits between this addendum's original text
and this entry).

**Rollback tag**: `pre-promotion-2026-08-02`, pointing at `origin/main`'s
pre-promotion tip `30c86d38023fd4a7dcf68a7889d3d56af6d65c6c` (the
"players(coworld): bounded post-final linger for platform reconciliation"
commit — the same SHA re-verified as unmoved immediately before the
push). Created and pushed to `origin` before touching `main`.

**Fast-forward push**: re-verified `git merge-base --is-ancestor
origin/main 756562c53018b6467c7400c728a958381962fd08` was true immediately
before pushing (both right after cutting the rollback tag and again in the
same breath as the push itself — `origin/main` never moved from
`30c86d380` across either check). `git push origin
756562c53018b6467c7400c728a958381962fd08:main` — fast-forward,
`30c86d380..756562c53`, **no force used and none required**. The exact
validated merge tip was promoted, not the shared worktree's later-moving
tip (siblings' post-`756562c53` commits stay on `claude/product-overhaul`
for the next promotion cycle).

**Public verification** (live GitHub, not just local fetch): repo page
renders correctly (README, LICENSE, LICENSE-ASSETS, correct AGPL-3.0
license badge, file tree). `git ls-tree -r --name-only origin/main --
docs/project-state` → **0 files** (this promotion's own untracking commit,
`756562c53`, is included, so the leak this doc flagged never reaches a
public reader). `git ls-tree -r --name-only origin/main -- .omp` → **0
files** (the earlier `.omp/` untrack from the 2026-08-01 review holds).
`git ls-tree -r --name-only origin/main -- src/client/prediction/wagering
src/server/replay-premiere/wagering` → **35 files present** — the
wagering surface is genuinely live on the public default branch now,
confirming "promote as is" was executed in full, not partially.

**Superseded standing decision**: the 2026-07-27 "zero wagering code on
`main`" rule (quoted and cited throughout this doc's "Main reconciliation"
section above) is superseded by the operator's 2026-08-02 decision, quoted
at the top of Addendum 4. `main` now carries the full wagering surface
under its existing `PROXYWAR_WAGERING_ENABLED`-gated structure (default
off; see the Step 3 inventory above for the gating detail).

`origin/main` final state: `756562c53018b6467c7400c728a958381962fd08`.
