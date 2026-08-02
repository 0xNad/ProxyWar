# Proxy War — Beta / Showcase Release Checklist

Date: 2026-07-31. Operator-facing checklist for cutting this overhaul over on
the live showcase surfaces. Deployment itself is an operator-gated outward
action (per `AGENTS.md`) — this document prepares every command; it does not
execute a push, deploy, or restart on its own authority.

## 1. Build

```bash
npm run inst              # npm ci --ignore-scripts — never npm install
npm exec -- tsc --noEmit
npm run lint
npm test                  # vitest run && vitest run tests/server
npm run test:e2e          # opt-in E2E suite (real server + Chrome)
npx vite build             # production client build → static/
```

`npm run build-prod` (`concurrently --kill-others-on-fail "tsc --noEmit"
"vite build"`) is the documented one-shot equivalent of the last two steps.
`npm run build-dev` is known-broken per `RUNBOOK.md` — do not use it for a
release build.

## 2. Deploy commands (existing gated path)

Per `deploy/README.md` + `deploy/mac/`, there is no single `deploy.sh` in
this repo — the deployment shape is a set of launchd-managed processes on a
macOS host behind a Cloudflare Tunnel or Caddy reverse proxy, each started
by one of the `deploy/mac/start-proxywar-*.zsh` wrapper scripts:

- `start-proxywar-platform.zsh` — the platform/apex origin
  (accounts, GitHub OAuth, `/player/:name`; `PROXYWAR_PLATFORM_ENABLED=1`,
  `AI_LEAGUE_DEMO_PORT=8793`, `PROXYWAR_PLATFORM_ORIGIN` set to the apex's
  own HTTPS origin, `PROXYWAR_LEAGUE_WRAPPER_ONLY=true`). Wagering is OFF on
  this process by construction (no `PROXYWAR_WAGERING_ENABLED` export).
- `start-proxywar-premiere-loop.zsh` — the Phase 2 bounded watcher
  (`src/scripts/replay-premiere-loop.ts`), launchd `StartInterval=60`. See
  `PROXYWAR_PREMIERE_RUNBOOK.md`.
- `start-proxywar-cloudflared.zsh` — the tunnel process, if using Cloudflare
  Tunnel rather than a direct reverse proxy.
- `backup-proxywar-beta.zsh` — scheduled backup, wired via
  `com.proxywar.beta-backup.plist.example`.

Do not `launchctl kickstart -k` an already-loaded beta service — see
`deploy/README.md`'s "Control-run transaction" section for the exact
hash/capture/bootout/bootstrap/verify sequence, and use
`node deploy/mac/proxywar-beta-launchd-restart.mjs [--dry-run]` for routine
restarts (it fails closed unless the installed plist/wrapper, process group,
server PID, writer lock, and loopback readiness all match).

**Confirm live before cutover, not assumed from these templates:** which
exact hostname (`beta.proxywar.xyz` vs `proxywar.xyz`) is reverse-proxied to
which exact backend port on the current production host — the example
`Caddyfile.example`/`cloudflare-tunnel.yml.example` in this repo are
single-hostname templates, and the live tunnel/Caddy config is the actual
source of truth for that mapping, not this repo.

## 3. Feature flags / env vars for this cutover

| Var | Purpose | Cutover value |
|---|---|---|
| `PROXYWAR_LEAGUE_WRAPPER_ONLY` | Serves the pre-generated static mirror + `public.html` SPA rather than full live-hosting machinery. | `true` on the league-facing process. |
| `PROXYWAR_PLATFORM_ENABLED` | Enables `/account`, GitHub OAuth, platform root HTML at `/`. | `1` on the apex process only, unset on the league process. |
| `PROXYWAR_PLATFORM_ORIGIN` | The apex's own HTTPS origin — every league-side consumer (`accountUrl` in the read model, cross-origin fetches) resolves against this. | The real apex HTTPS URL, e.g. `https://proxywar.xyz`. Client build-time value must match — rebuild `static/` (`npx vite build`) whenever this changes. |
| `PROXYWAR_PLATFORM_RETURN_ORIGINS` | JSON object (audience → origin) allowlisting which audiences may complete a cross-origin handoff. MUST be valid JSON — a comma-separated list silently drops the whole allowlist and 400s every audience. | Whatever audiences are actually wired (currently: betting). |
| `PROXYWAR_WAGERING_ENABLED` | The entire wagering-surface gate. | UNSET on every league-origin process for this cutover — league surfaces must serve no betting UI or route. See `PROXYWAR_PUBLIC_APP_ARCHITECTURE.md`'s security-boundaries section. |
| `PROXYWAR_GITHUB_OAUTH_CLIENT_ID` / `_SECRET_FILE` | GitHub sign-in on the platform origin. Secret passed as a FILE PATH, never a value (`ps eww <pid>` dumps env). | Set on the platform process only. Absent = sign-in cleanly does not exist (no button, no routes) — a valid unconfigured state, not a bug. |

### Cutover switch, verified (not assumed)

**The cutover flag is `PROXYWAR_LEAGUE_WRAPPER_ONLY` itself — no new flag,
no renamed flag.** The pre-overhaul league origin already runs with this
set `true` (per the row above); this overhaul's entire public app (every
Stage 2-7 route: `/`, `/watch`, `/agents`, `/agent/:slug`, `/builders`,
`/builder/:slug`, `/build`, `/about`, `/match/:matchId`, premiere pages)
is reached through the exact same flag on the NEW build's code —
`leagueWrapperOnly && !platformEnabled` is what selects
`sendPublicAppShellPage()` (the `public.html` SPA shell) at `/` in
`ai-agent-demo-server.ts`. Cutover is therefore: deploy this overhaul's
code with the SAME existing env convention already in the running launchd
plist — no plist edit, no new env var, no code-level flag flip required.
Verified empirically this session, not assumed: every fixture-server run
in Stage 8/9 (`npm run fixtures:public-product`, which sets
`PROXYWAR_LEAGUE_WRAPPER_ONLY=true` and nothing else app-shell-related)
served the full new app end to end — all 14 routes above returned 200
with real content, confirmed again capturing this stage's after-
screenshots. The pre-overhaul code, under the identical flag, only ever
served `/league` (Stage 0 audit: "Only implemented public route on beta
is `/league`... root is a bare redirect") — the difference is entirely in
which code is running, not in any env value that needs to change at
cutover time.

### CSP note

There is no framework-level CSP middleware in this codebase. CSP is applied
explicitly, per response, through one shared function:
`pageContentSecurityPolicyWithNonce(leagueContentSecurityPolicy(),
scriptNonce)` for every `public.html`-shelled page, and the bare
`leagueContentSecurityPolicy()` for the static `/league` mirror. Before
cutover, curl a representative page and eyeball the `Content-Security-Policy`
header — confirm `connect-src` includes the platform origin (needed for the
PoV-claims cross-origin read) and does not silently block it, which is
exactly the bug the Stage 0 audit of this overhaul found on the pre-overhaul
beta (`connect-src 'self'` blocking the PoV-claims fetch — see
`PROXYWAR_PUBLIC_PRODUCT_AUDIT.md` §10).

## 4. Pre-deploy checks

- [ ] Rollback point preserved: the old static league page remains servable
      as an emergency fallback until the new app is live-verified — do not
      remove or overwrite it as part of this cutover.
- [ ] Replay retention verified: `deploy/coworld-league-retention-pins.json`
      pins every episode a scheduled/active Premiere depends on (see
      `PROXYWAR_PREMIERE_RUNBOOK.md`'s retention-pins section).
- [ ] Every public route in the smoke list below validated locally against
      a fixture or staging server first.
- [ ] Wrapper-only security confirmed locally: run
      `npx vitest run tests/server/security/PublicSurfaceSecurity.test.ts`
      against a real spawned server and read the output directly — do not
      infer from a prior run.
- [ ] Direct reloads confirmed on every public route (no client-routing-only
      pages that 404 on a real GET) — covered by
      `tests/e2e/PublicProductJourneys.e2e.test.ts`'s reload cases.
- [ ] No private/mutating/operator-billed endpoint publicly reachable —
      same security suite as above.
- [ ] Feature flag for cutover follows the existing env convention
      (`deploy/proxywar-beta.env.example`) — do not invent a new mechanism.

## 5. Request the operator gate

State the exact command list above (build, the specific `launchctl
bootstrap`/`proxywar-beta-launchd-restart.mjs` invocation, and which
`deploy/mac/*.plist` files are involved) and ask for explicit go-ahead
before executing any of it. If the gate isn't granted, everything above is
still the deliverable: validated locally, ready to run, with the single
named blocker stated plainly. Never claim "deployed" without live proof —
proof means a real HTTP round trip against the live host, not a local test
pass.

## 6. Post-deploy smoke (spec Stage 9 item 3, as a literal checklist)

Run each of these against the live host after deploy, not before:

- [ ] `/`
- [ ] `/watch`
- [ ] `/league`
- [ ] `/agents`
- [ ] one `/agent/:slug`
- [ ] `/builders`
- [ ] one `/builder/:slug`
- [ ] `/build`
- [ ] `/account` (on the platform origin)
- [ ] one `/player/:name`
- [ ] a PoV-claims CORS probe from the league origin against the platform
      origin (confirms the `connect-src` CSP gap the Stage 0 audit found is
      not regressed)
- [ ] one pre-match / upcoming-Premiere page
- [ ] one active/live Premiere state. **Local/fixture testing note (found
      2026-07-31 while capturing Stage 9 screenshots):** the premiere
      page's interaction/session-bootstrap layer requires a trusted
      `X-Forwarded-For` (only `127.0.0.1`/`::1` peers are trusted to
      assert one, matching the managed Cloudflare Tunnel's real
      loopback-with-header shape — `REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES`
      in `ReplayPremiereClientAddress.ts`). A direct fixture-server
      connection (no reverse proxy in front) has no forwarding header at
      all, so the page hangs on "Loading premiere…" with
      `operatorCode=remote_address_unavailable` in the server log — a
      local-testing artifact, not a live-deployment bug (the real tunnel
      always sets this header). Simulate it when testing locally:
      `Network.setExtraHTTPHeaders({"X-Forwarded-For": "<any address>"})`
      via CDP, or an equivalent header injection for a manual browser
      test.
- [ ] one completed match page
- [ ] one Director Cut playback (a match with `director-cut-plan.json`
      present)
- [ ] one Full Replay
- [ ] one old `/openfront-replay/:runID` legacy link (confirms the compat
      redirect still resolves)
- [ ] stale-data handling (force a stale read model and confirm the banner,
      not a crash)
- [ ] private-route denial (`/tester-dashboard`, `/admin`, `/api/status` —
      confirm still non-200 anonymously on the live host)
- [ ] `bet.proxywar.xyz` unaffected (loads and functions exactly as before
      this cutover — it shares the replay-premiere subsystem but must show
      zero behavioral change)
- [ ] `npm run agent:hosted-beta:readiness -- --require-ready` passes
      against the live env

## 7. After-screenshots and final report

Capture after-screenshots under `artifacts/product-overhaul/after/`
(gitignored, untracked operational artifacts — same convention as the
Stage 0 before-screenshots) across the same viewports the Stage 0 audit
used (1440×900, 1280×720, 390×844, 844×390 landscape), covering the same
route set the Stage 0 audit captured plus every new Stage 2-7 route. File
the final report per `AGENTS.md`'s "Decision And Progress Updates"
discipline: what changed, commands run, test/readiness result, remaining
risks, next concrete step.

## Rollback path

### Current deployed state (as of 2026-07-31, before this overhaul's cutover)

- **`beta.proxywar.xyz` (league origin):** the pre-overhaul league-monitor
  line — the last commit this overhaul's `main` ancestor shares with what
  is live is `c35e6be87` (`fix(league): derive battle-card map from
  variant_name; drop difficulty`). This overhaul (`claude/product-overhaul`)
  branched from `claude/betting` at `6e0d90a7f`, whose own `main` ancestor
  is the same `c35e6be87`. **Not yet re-verified against the current live
  host** — this document records the branch-graph fact, not a live probe;
  confirm the actual deployed commit on the host before relying on this for
  a real rollback decision (`curl` a version/build marker if the deployment
  exposes one, or check the running process's own checkout).
- **`proxywar.xyz` (apex/platform origin):** live since 2026-07-30 from the
  `claude/betting` line (`start-proxywar-platform.zsh`,
  `PROXYWAR_PLATFORM_ENABLED=1` + `PROXYWAR_LEAGUE_WRAPPER_ONLY=true`) —
  accounts, GitHub OAuth, `/player/:name`. This overhaul's identity/
  read-model work extends this same line; the apex does not roll back to a
  pre-accounts state as part of this cutover's rollback path (accounts
  predate and are independent of this overhaul).
- **Origin drift found while preparing this section (2026-07-31):**
  `origin/main` has advanced 3 commits past `c35e6be87`
  (`1855d5575`/`4b66af87b`/`6f366d8ed`, "schedule every competition
  champion" + "Integrate production Coworld commissioner semantics") that
  are NOT in `claude/product-overhaul`. Checked their diff: all three touch
  only `coworld-adapter/commissioner/**` (Coworld scoring/scheduling
  backend) — zero overlap with any file this overhaul touches. Not a
  blocker for this cutover, but whoever merges `claude/product-overhaul`
  toward `main` afterward should reconcile these first.

### Rollback commands (verified to exist and parse; NOT executed)

All of the following were confirmed present and syntactically valid this
turn (`node --check`, `bash -n`) without running them:

```bash
# Routine restart / rollback trigger (fails closed — see deploy/README.md's
# "Control-run transaction" for what "fails closed" restores):
node deploy/mac/proxywar-beta-launchd-restart.mjs --dry-run
node deploy/mac/proxywar-beta-launchd-restart.mjs
# If the deployment serves a non-default port:
node deploy/mac/proxywar-beta-launchd-restart.mjs --ready-url=http://127.0.0.1:<port>/league
```

If the cutover fails post-deploy smoke: `proxywar-beta-launchd-restart.mjs`
without `--dry-run` restores the previously bootstrapped plist/wrapper if
the new one fails its own readiness gate (it fails closed, never leaves a
half-swapped state — see `deploy/README.md`'s rollback procedure for the
exact hash-verify/bootout/bootstrap/recheck sequence). The old static
league page (§4's first checklist item) is the last-resort fallback if the
whole `public.html` SPA needs to be pulled — it requires no process restart,
since `/league` is served from the pre-generated static mirror independent
of which SPA build is currently live, at:

```text
artifacts/ai-league-runs/league/index.html   (repo-relative, on the host's
                                               configured PROXYWAR_ARTIFACTS_ROOT)
```

regenerated on its own ~30s cycle by the existing mirror writer
(`CoworldLeagueSiteWriter.ts`), independent of whether the `public.html`
SPA build currently deployed is this overhaul's or the pre-overhaul one —
pulling the SPA never breaks `/league` itself.

## Known gaps

- Exact production hostname → backend-port mapping for `beta.proxywar.xyz`
  vs `proxywar.xyz` is not fully re-derivable from this repo's example
  Caddyfile/tunnel templates alone (they're single-hostname templates) —
  confirm against the live Caddy/cloudflared config before cutover, not
  this document.
- No automated post-deploy smoke script runs the full checklist in §6 as
  one command yet — `npm run agent:hosted-beta:smoke` covers a subset; the
  rest is manual per this checklist.
