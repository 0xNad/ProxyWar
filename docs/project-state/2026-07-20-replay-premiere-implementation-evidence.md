# Proxy War Replay Premiere — implementation evidence

Status: local implementation verified; browser and deployment proof pending
Control owner: Codex
Contract: `2026-07-20-proxywar-premiere-loop-product-spec.md`
Contract SHA-256: `e56f7ff7f751dfc2b3ecba593bfc29bbb2ad3cc9cfbc2ec80ac449ea78a8312d`

This file is the completion ledger for the non-conditional requirements in the
contract. A source change is not completion evidence by itself. Every row must
end with current test, browser, and (where applicable) deployed-runtime proof.

## Evidence matrix

| Gate | Required proof | Current state | Evidence |
| --- | --- | --- | --- |
| Eligibility and provenance | Exact Coworld, variant, replay, policy-version, source, and derived-artifact hashes; embargo/public-outcome classification; pre-schedule leak audit | In progress | Phase 0 server worker |
| Private source containment | Full source and result remain outside every static/artifact root; traversal, symlink, range, HEAD, alternate-route, and cache escapes fail closed | In progress | Phase 0 server worker + independent network audit |
| Progressive release integrity | Ordered immutable content-addressed hash-chained chunks; no unreleased sequence or result is obtainable; no extra turn crosses a checkpoint | In progress | Phase 0 server/client workers |
| Playback fallback | Real-client progressive playback passes integrity and late-join gates, or controlled silent time-gated video is selected | Pending | Phase 0 two-browser spike |
| Authoritative clock | Shared position; fixed 1x/2x/4x pre-reveal; drift <=1.5s; >2s auto-resync; reconnect/late join <=5s | Pending | Phase 1 integration + browser proof |
| State machine and recovery | Only contract transitions; sanitized failure; restart recovery/fail-safe <=10s; outage shift/fail rules | In progress | Phase 0 store foundation, Phase 1 integration |
| Predictions | Exactly two 15s checkpoints near 35%/65%; released-state seats only; idempotent/409/410 rules; hidden distribution; winner/void semantics | Pending | Phase 1 service/UI/tests |
| Structured markers | Exact five kinds; no free text; dedupe; 30 total and 5/minute; archive rejects | Pending | Phase 1 service/UI/tests |
| Guest/security | Signed Secure HttpOnly SameSite=Lax cookie; CSRF and strict Origin; bounded bodies/state; no internal error leakage | Pending | Phase 1 routes + adversarial tests |
| Persistence | Append-only JSONL plus atomic snapshots; schema/version/recovery/ceilings/migration seam | In progress | Phase 0 store foundation |
| Ambient mode | Usable at 640x360 and half 1280x720; keyboard, screen-reader, reduced-motion behavior | Pending | Phase 1 UI + browser proof |
| Sharing and attribution | Timestamped canonical link; permanently spoiler-neutral card; signed seven-day last-non-direct attribution; plaintext challenge export only | Pending | Phase 2 implementation/tests |
| Measurement | Qualified-session, interaction, completion, share, and return metrics; three-premiere pilot rule | Pending | Phase 1/2 events + audit |
| Localization | Every user-visible string uses `translateText()` with English entry only | Pending | Completion audit |
| Architecture | No `src/core/**`; no alternate runner/validator/raw-intent path | In progress | Diff audit + independent review |
| Regression/build | Focused and integration tests, `tsc`, lint, production build, ordinary league/replay compatibility | Pending | Completion suite |
| Deployment | Exact reviewed server/client/publisher commit deployed together; local and public verification; rollback identity recorded | Blocked until candidate exists | Release cutover ledger |

## Current verified baseline

- Live production at the start of work serves the ordinary completed replay
  viewer from `.claude/worktrees/main-release` at
  `35d9aeacffd3fa4a691689974b74dfbc4fdbe011`.
- Replay Premiere routes are not implemented in that release.
- The ordinary league bundles expose `game-record.json`, summaries, decisions,
  and telemetry. They are categorically ineligible as pre-reveal source roots.
- The current client loads a complete `GameRecord` and `LocalServer` expands all
  turns before playback. Phase 0 must replace that path for premieres or select
  the contract's silent-video fallback.
- The primary checkout contains pre-existing replay-hardening work. It must be
  preserved and separated from unrelated dirty files during integration.
- Deployment cannot silently mutate the unregistered legacy `main-release`
  worktree. A managed replacement also remains below the 27 GiB creation floor.

## Phase exit rules

## Independent Phase 0 review — 2026-07-20

Current verdict: **NO-GO** until the implementation and live evidence close
every item below. The review verified that the deployed ordinary replay still
returns the full record (`200`) and byte ranges (`206`) and that no Premiere
route is deployed. Those are baseline facts, not a Premiere regression.

Hard gates carried into implementation and completion tests:

- leak-audit eligibility is recomputed from a versioned exact target manifest
  and raw observations; no caller-supplied `passed` value is trusted;
- a private random commitment nonce of at least 128 bits prevents the public
  eligibility hash becoming a brute-force result oracle;
- controlled exhibition output is created directly in verified private
  storage, with realpath, overlap, symlink, hard-link, mode, and served-root
  scans;
- only `GameStartInfoSchema` and `TurnSchema` validated records enter the
  progressive client; no partial `GameRecord` is constructed;
- terminal chunk publication and the revealed transition are one durable
  public transaction, with crash/concurrent-fetch tests;
- unreleased data is never placed under static middleware and range, HEAD,
  conditional, encoded-path, redirect, cache, and alternate-route probes are
  indistinguishable from a nonexistent resource;
- ordinary replay details, diagnostics, turn seeking, and speed controls stay
  disabled before reveal;
- the chunk hash definition binds the complete immutable descriptor, payload,
  byte length, release time, and prior hash, with independent tamper tests;
- a representative long replay reaches the authoritative late-join position
  within five seconds; otherwise the product uses the segmented silent-video
  fallback, never a single range-readable full MP4.

The review's complete adversarial matrix remains part of the Control-thread
evidence and must be reproduced against loopback and the public edge before
Phase 0 can be marked complete.

### Phase 0

Exit only when an eligible private replay can be staged and watched through the
chosen delivery path while an adversarial browser/network audit obtains zero
future turns, results, winner metadata, or full replay bundles before release.

### Phase 1

Exit only when two independent browsers pass clock, checkpoint, reconnect,
prediction, marker, recovery, ambient, accessibility, and security acceptance.

### Phase 2

Exit only when timestamp sharing, spoiler-neutral cards, attribution, and the
plaintext challenge export pass browser and abuse-path tests.

### Deployment

Exit only after the exact reviewed candidate is live, the server and mirror run
the same identity, public verification passes, and durable rollback evidence is
recorded. Local green tests do not grant release authority.

## Control verification log

### 2026-07-20 20:58 Europe/Lisbon

- Client progressive catch-up is bounded to 64 turns in flight and refills only
  as the worker completes turns; the 130-turn regression is green.
- Premiere JSON requests now have a hard five-second per-request timeout and
  stream response bodies under the configured byte ceiling even without a
  `Content-Length` header. A fetch implementation that ignores `AbortSignal`
  still times out. Focused network tests: 18/18; scoped ESLint: clean.
- Full TypeScript remains intentionally red while the Phase 0 publication gate,
  recovery schema, canonical result, and interaction-resolution contracts are
  being repaired. This is not completion evidence.
- Independent review remains NO-GO on source-to-bootstrap/chunk/result identity,
  full recovery-payload validation, reveal-provenance binding, and honest
  browser-verifiability of the publication commitment. No real exhibition and
  no deployment has been attempted.

### 2026-07-20 21:14 Europe/Lisbon — storage admission

- Available space increased from 21 GiB to 23 GiB without touching Proxy War
  artifacts, outputs, Docker state, branches, dirty trees, retained worktrees,
  the live frontend checkout, or the active Codex runtime.
- The idle browser-harness daemon was stopped after verifying that no client
  held its socket. `uv cache clean` removed 79,701 rebuildable cache files
  (reported 3.0 GiB). The unused Solana v1.48 platform-tools cache and the
  inactive Hugging Face hub cache were also cleared after open-handle checks.
- A Go module-cache cleanup removed only writable cache entries; read-only
  module files failed closed and were left in place. No permission broadening
  was attempted.
- The host remains below the 27 GiB managed-worktree creation threshold. The
  installed 15-minute storage job is healthy but only audits/reaps registered,
  expired worktrees; 26 legacy worktrees are intentionally audit-only, and no
  registered worktree is currently eligible. A new release worktree remains
  blocked unless more safe capacity is reclaimed or an existing valid release
  path avoids new worktree creation.

### 2026-07-20 23:27 Europe/Lisbon — local candidate verification

- The server implementation now includes fail-closed eligibility and private
  staging, content-addressed hash-chained chunks, authoritative result binding,
  event-journal recovery, interaction persistence, exact startup reconstruction,
  bounded runtime supervision, guest security, spoiler-neutral page/card routes,
  and operator-only admission. The client includes the exact `/premiere/:id`
  route, progressive replay transport, authoritative playback coordination,
  predictions, structured markers, archive/failure behavior, sharing, and
  translated UI strings. No `src/core/**` file changed.
- Independent local review returned GO for publication binding, catalog lock
  lifecycle, delayed-commit fencing, origin reconstruction, unusual-name
  diagnostics, retry/backoff, rollback, and shutdown. The final deterministic
  suite passed 205/205 twice with four workers and `--trace-warnings`; no
  Replay Premiere temp residue, open handle, or `FileHandle` warning remained.
- Exact root verification passed: `npm exec -- tsc --noEmit`; production build;
  lint with zero errors (110 wider-tree warnings); `npm test` with 224 files and
  2,229 tests followed by 115 server files and 1,127 tests; and a bounded
  trace-warning rerun of all 2,229 tests. The newly exposed league HTTP fixture
  now loads the repository tsconfig explicitly and keeps canonical private state
  outside every served fixture root; its focused contract passes 4/4.
- Replay Premiere-specific evidence passed: server 144/144, admission CLI
  13/13, controlled-exhibition provenance and disk policy 12/12, and client
  runtime 61/61. After the disk-policy remediation, the bounded integrated
  client/server/route matrix passed 28 files and 235 tests under
  `--trace-warnings`. The production bundle compiled 1,920 modules.
- Coworld adapter TypeScript passes. Current unpinned `npm run certify` fails
  before execution with `manifest_invalid` because the selected Coworld CLI now
  requires at least three manifest tags. No episode was attempted after that
  prerequisite failure, and no hosted Coworld state was mutated.
- Browser acceptance, a real admitted controlled exhibition, two-browser clock
  and reconnect proof, public-edge leak checks, mobile/ambient evidence, exact
  release commit identity, deployment, and rollback verification are still
  missing. The live site remains on the pre-Premiere release.
- Storage remains below release admission: after deleting only rebuildable UV
  cache and verified no-handle temporary build residue, available space is about
  19 GiB. No replay, artifact, output, Docker state, branch, worktree, or active
  runtime was deleted. A new managed worktree remains prohibited below the
  fixed 27 GiB threshold.
