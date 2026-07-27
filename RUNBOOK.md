# Proxy War Replay Premiere + Live Betting — local runbook

Status as of this session (Unblock): the client-side "Joining live…" hang is
**fixed** — root-caused to two independent client bugs (see §12), not the
`joinLobby`/replay-premiere join-lobby path the original diagnosis suspected.
A controlled-exhibition premiere admitted with wagering on now loads all the
way to a rendering replay, a populated LMSR trade ticket, and a **live, real
buy** was driven in a real headless-Chromium browser: price moved from
25.0→35.5 on the bought seat (exact match to the quoted preview) and the
bankroll debited exactly the quoted cost. See §12 for exactly what was and
was not verified live before this session ran out of budget — sell, hold-to-
settlement, the synthetic crowd, and reload-survival were **not** reached.
Everything below is real, reproduced, command-verified output from this
session (Integrate's original content, §0–§11, is unchanged and still
accurate), not aspirational instructions.

## 0. Why `/bet/<id>` and `/premiere/<id>` said "Replay unavailable" for every id

Nobody had ever gotten a controlled-exhibition premiere through admission on this branch.
Three independent, structural bugs blocked it, all fixed in this session (see §5):

1. `replay-premiere-controlled-exhibition.ts` refuses to run unless `git status --porcelain`
   and `git diff HEAD` are **both** empty (binds build provenance to a clean commit). This
   branch is under continuous multi-agent WIP, so every previous attempt failed before a
   single agent action ran.
2. In `GAME_ENV=dev` (the only way `ai-agent-demo-server.ts` is normally started),
   `/ai-league-replay/*` is proxied straight to the Vite dev renderer, which serves the
   generic SPA shell (HTTP 200) for **any** path, including a nonexistent id. The Replay
   Premiere leak audit requires that route to 403/404 for a private `sourceRunId` — it
   never can in dev mode, so admission always failed leak-audit collection.
3. Even with `PROXYWAR_LEAGUE_WRAPPER_ONLY=true` (production-like static routing, which
   fixes #2), `isProxyWarPublicLeaguePath` treats **any** `/ai-league-runs/league-<x>/...`
   path as public-league shaped and lets it fall through to the real static/artifact
   routes. Those correctly 404 when the run doesn't exist on disk, but the server had no
   final catch-all, so the 404 fell through to Express's default handler, which echoes the
   request path (`Cannot GET /ai-league-runs/league-<sourceRunId>/...`) — a leak-audit
   fingerprint match on the very `sourceRunId` we're trying to keep private. This failed
   for literally any sourceRunId, unconditionally.

Two more gaps surfaced once admission itself worked (also fixed, §5):

4. Multiple concurrent agents on this machine each defaulted to the same
   `~/Library/Application Support/ProxyWar/storage/replay-premiere` private state root.
   `ReplayPremiereEventStore`'s single-writer lock means only one live process can hold
   that root; every other process gets `writer_already_active_on_host` and disables
   premieres entirely for itself. This alone reproduces "Replay unavailable" for **every**
   id on a machine with more than one demo-server process running against the default root.
5. `/bet/:premiereId` had zero server-side route recognition (`isProxyWarPublicPremiereReadPath`
   only knew about `/premiere/:id`) — in league-wrapper-only mode it fell through to a
   redirect to `/league` instead of the app shell.

## 1. One-time setup

```sh
npm run inst                 # npm ci --ignore-scripts (verified present already)
npx tsc --noEmit              # clean
```

The tracked-code fixes below already landed on `claude/betting` (this session's commits);
skip straight to §2 on a checkout that already has them.

## 2. Build the static client

`npm run build-dev` **is currently broken** — `vite build --mode development` fails with
`EISDIR: illegal operation on a directory, read` in the `vite:build-html` plugin (a
dev-mode-only interaction between the proprietary-asset pipeline and the empty
`assetManifest` used outside production mode; not something introduced by this session,
and out of scope to fix here). Use the production build instead — it succeeds and is what
`PROXYWAR_LEAGUE_WRAPPER_ONLY` mode serves from anyway:

```sh
npx vite build
# [log] vite v8.0.10 building client environment for production...
# transforming...✓ 1951 modules transformed.
# [log] static/index.html                              23.40 kB │ gzip:   6.33 kB
# static/assets/index-<hash>.js                       3,339.72 kB │ gzip: 898.09 kB
# [log] ✓ built in 1.57s
```

Rebuild this any time client source changes and you're testing through
`PROXYWAR_LEAGUE_WRAPPER_ONLY=true` (that mode serves `static/`, not live Vite HMR).

## 3. Stage a local agent-manifest directory (one-time)

`docs/ai-league-agent-manifests/*.json` are missing the `policyIdentity` field the
controlled-exhibition importer requires. Copy them and add it (do **not** edit the shared
docs manifests):

```sh
mkdir -p /tmp/proxywar-premiere-manifests
python3 - <<'PY'
import json, os
src, dst = "docs/ai-league-agent-manifests", "/tmp/proxywar-premiere-manifests"
for fname in sorted(os.listdir(src)):
    if not fname.endswith(".json"): continue
    data = json.load(open(os.path.join(src, fname)))
    slug = fname[:-5]
    data["policyIdentity"] = {"namespace": "local_manifest", "manifestName": slug, "declaredVersion": "v1"}
    json.dump(data, open(os.path.join(dst, fname), "w"), indent=2)
PY
```

## 4. Generate a controlled-exhibition source bundle

`premiere:controlled-exhibition` runs a real, deterministic, in-process 4-agent match
(brain=planner/mock-llm — no network, no LLM API keys, no Softmax/Coworld dependency) and
writes one `<run-id>.source.json` bundle to a private staging root. **The repo tree must be
fully clean (`git status --porcelain` empty, `git diff HEAD` empty) for the whole duration
of the run** — commit or stash any WIP first (a plain `git commit` is safe; it doesn't
discard anything, and PariServer/MarketSim's own uncommitted work is unaffected on disk).

Turn count/turn-interval matter: with wagering on, the server enforces `maxPresentationSpanMs
<= 1000ms` per chunk and a **hard 128-chunk ceiling**, so `turnCount * turnIntervalMs` must
stay `<= ~128,000ms`. A real 4-agent FFA on Asia/Compact with alliances disabled took
10,800 turns to produce a winner in this session — use `--playback-turn-interval-ms=10` to
keep nominal duration at 108s (well under the ceiling). Real observed run:

```sh
mkdir -p /tmp/proxywar-premiere-staging
git add -A && git commit -m "WIP checkpoint for controlled-exhibition provenance"   # if dirty

GAME_ENV=dev npx tsx src/scripts/replay-premiere-controlled-exhibition.ts \
  --run-id=local-dev-premiere-2 \
  --private-output-root=/tmp/proxywar-premiere-staging \
  --agent-manifest-dir=/tmp/proxywar-premiere-manifests \
  --served-root="$(pwd)" \
  --served-root="$(pwd)/static" \
  --served-root="$(pwd)/artifacts" \
  --served-root="$(pwd)/docs" \
  --served-root="$(pwd)/examples/external-agent" \
  --brain=planner \
  --disable-alliance-actions \
  --max-steps=200 \
  --turns-per-decision-step=100 \
  --replay-tail-turns=400 \
  --playback-turn-interval-ms=10
```

Real result from this session (exit 0, ~70s wall time):

```
turnCount 10800, turnIntervalMs 10  (nominal duration 108s)
winner ['player', '3ba8c49c']  (Defensive Builder)
bundleSha256 8eed82b5bc1a727e4e63097ed7a26e3c86d5c1ebff8c4c6eb4df37875b45ac34
bundlePath /tmp/proxywar-premiere-staging/local-dev-premiere-2.source.json
```

`--run-id` must be unique per bundle (the destination file must not already exist).
Compute checkpoints at 35%/65% of `turnCount` (matches
`checkpointSequencesForTurnCount` in `ReplayPremiereLoopCore.ts`): here, `3780`/`7020`.

## 5. Start the demo server

```sh
GAME_ENV=dev \
PROXYWAR_WAGERING_ENABLED=1 \
PROXYWAR_PUBLIC_URL=http://127.0.0.1:8787 \
PROXYWAR_REPLAY_PREMIERE_STATE_ROOT=/Users/<you>/.proxywar-dev-integrate/replay-premiere \
PROXYWAR_LEAGUE_WRAPPER_ONLY=true \
npx tsx src/scripts/ai-agent-demo-server.ts
```

- `PROXYWAR_WAGERING_ENABLED=1` — turns on the LMSR market (off by default).
- `PROXYWAR_PUBLIC_URL` — must match `--deployment-origin` used for admission below; without
  it, admission fails closed with `admission_deployment_origin_not_configured` (a real,
  no-loopback-by-default safety check, not a bug).
- `PROXYWAR_REPLAY_PREMIERE_STATE_ROOT` — **use a path unique to your session**, not the
  default `~/Library/Application Support/ProxyWar/storage/replay-premiere`. Any other
  concurrently-running demo-server process on this machine (there were two from other
  agents during this session, on ports 8788 and unbound) holds the single-writer lock on
  the default root and starves every other process's premiere subsystem entirely
  (`writer_already_active_on_host` → "premieres disabled for this process" → every
  `/premiere/<id>` and `/bet/<id>` 404s with "Replay unavailable", independent of anything
  admission-related).
- `PROXYWAR_LEAGUE_WRAPPER_ONLY=true` — serves the built `static/` client instead of
  proxying to a Vite dev server, and is required for the leak-audit fix (§0.2/§0.3) above
  to actually take effect. Without it, `npm run build-dev`'s Vite dev-mode SPA fallback
  defeats the leak audit unconditionally.

Real boot log observed:

```
[league-clips] canary clip_canary_state_missing
Proxy War demo hub: http://127.0.0.1:8787
Public URL: http://127.0.0.1:8787
Proxy War renderer: built client at /Users/claude/Documents/proxywar_main/static
Press Ctrl-C to stop.
```

## 6. Admit the premiere

Build eligibility/definition/nonce inputs (nonce must live outside every served root, on a
canonical — i.e. not `/tmp`-symlinked, use `/private/tmp` on macOS — path):

```sh
mkdir -p /private/tmp/proxywar-premiere-admit-inputs
python3 -c "import os; open('/private/tmp/proxywar-premiere-admit-inputs/nonce.bin','wb').write(os.urandom(32))"
chmod 600 /private/tmp/proxywar-premiere-admit-inputs/nonce.bin

cat > /private/tmp/proxywar-premiere-admit-inputs/eligibility.json <<'JSON'
{
  "schemaVersion": 1,
  "eligibilityCheckVersion": "local-dev/v1",
  "externalEmbargoEvidence": [
    {"source": "controlled runner", "scope": "source and outcome",
     "observedAt": "<current UTC ISO timestamp, within 5 minutes of the admit call>",
     "verifier": "operator", "embargoConfirmed": true}
  ],
  "externalOutcomeMayBePublic": false,
  "publicLabel": "premiere"
}
JSON

cat > /private/tmp/proxywar-premiere-admit-inputs/definition.json <<'JSON'
{
  "schemaVersion": 1,
  "title": "Local Dev Premiere - Controlled Exhibition",
  "spoilerNeutralDescription": "A controlled four-agent exhibition match on Asia (Compact).",
  "map": {"id": "Asia", "label": "Asia"},
  "matchFormat": {"id": "ffa-4", "label": "4-seat FFA", "seatCount": 4},
  "scheduledAt": "<current or near-future UTC ISO timestamp>",
  "playbackRate": 1,
  "checkpoints": [
    {"id": "cp_00000001", "sequence": 3780},
    {"id": "cp_00000002", "sequence": 7020}
  ]
}
JSON
```

`checkpoints[].id` must match `/^cp_[a-z0-9]{8,32}$/` (no underscores). `map.id` must equal
the literal `gameMap` config string baked into the source bundle. `scheduledAt`/
`observedAt` must be fresh — the admit script rejects both a stale eligibility timestamp
and a checkpoint span it can't chunk. Give yourself a little lead time on `scheduledAt`: the
release clock starts counting from it, and with wagering's ~108s window here, `scheduledAt`
too far in the past leaves nothing to interact with by the time you open a browser (the
premiere transitions to `failed`/void after a service-outage tolerance is exceeded).

```sh
GAME_ENV=dev PROXYWAR_PUBLIC_URL=http://127.0.0.1:8787 npx tsx src/scripts/replay-premiere-admit.ts \
  --premiere-id=prem_<20 lowercase alnum chars> \
  --source-file=/private/tmp/proxywar-premiere-staging/local-dev-premiere-2.source.json \
  --expected-source-sha256=8eed82b5bc1a727e4e63097ed7a26e3c86d5c1ebff8c4c6eb4df37875b45ac34 \
  --private-state-root=/Users/<you>/.proxywar-dev-integrate/replay-premiere \
  --served-root="$(pwd)" --served-root="$(pwd)/static" --served-root="$(pwd)/artifacts" \
  --served-root="$(pwd)/docs" --served-root="$(pwd)/examples/external-agent" \
  --eligibility-file=/private/tmp/proxywar-premiere-admit-inputs/eligibility.json \
  --definition-file=/private/tmp/proxywar-premiere-admit-inputs/definition.json \
  --deployment-origin=http://127.0.0.1:8787 \
  --nonce-file=/private/tmp/proxywar-premiere-admit-inputs/nonce.bin \
  --max-presentation-span-ms=1000
```

`--max-presentation-span-ms=1000` is a **new optional CLI flag added in this session**
(`replay-premiere-admit.ts`); without it the script's chunk build always uses its 45s
default span, which exceeds wagering's hard 1s ceiling and gets the whole admission
rejected at server startup with `wagering_presentation_span_exceeded_ceiling`. Omit this
flag entirely for non-wagering admissions (default behavior is unchanged).

Real successful output from this session:

```json
{"premiereId":"prem_asvlm54vtb1oa57ulfcd","sourceRunId":"local-dev-premiere-2","sourceReplaySha256":"8eed82b5bc1a727e4e63097ed7a26e3c86d5c1ebff8c4c6eb4df37875b45ac34","eligibilityRecordHash":"9cd24f9dec4b98ded0ad70ca571db1a0015c6051e64c756d55d26bdc921bdc78","publicationCommitmentHash":"84c098b977f76415e1b2f6793888f154c6c5d42215c7b6e07a39c2e1d1413843","orderedDraftManifestRoot":"0e17acb3c2de3e237ab0cc5fb5d8ccc161728736e3e49dbc69553e638fcd7e11","admissionRecordHash":"7b047c35f170cf18913837686426a3ca798dec0ab6b1cae0ac45288138e0a62e","deploymentOriginSha256":"b1a61bf29a38ff3642af0dad0785e1677a58232f2e9bb85db3f7a80d8bf1a387"}
```

## 7. Activate it

Admission never hot-registers; the server must restart and reconstruct its catalog:

```sh
# Ctrl-C the server from §5, then start it again with the same env vars.
```

## 8. Verify

```sh
curl -s http://127.0.0.1:8787/premiere/prem_asvlm54vtb1oa57ulfcd -o /dev/null -w '%{http_code}\n'
# 200
curl -s http://127.0.0.1:8787/bet/prem_asvlm54vtb1oa57ulfcd -o /dev/null -w '%{http_code}\n'
# 200
curl -s http://127.0.0.1:8787/api/premieres/prem_asvlm54vtb1oa57ulfcd/market
# {"schemaVersion":1,"market":{"outcomeSeatIds":["e6f38a5f","3ba8c49c","4feb45d4","f2911b95"],
#  "b":10,"q":[0,0,0,0],"prices":[25,25,25,25],"status":"open","winnerSeatId":null,"positions":null}}
```

A screenshot of the betting page rendering (sidebar with title/bankroll) was captured for
an earlier admitted instance of this same flow (before it aged out — see §9):

- title "Local Dev Premiere - Controlled Exhibition", "Asia · 4-seat FFA", "Your bankroll
  1,000 cr" all rendered correctly from real bootstrap data.

## 9. Resetting state between runs

- Stop the server, delete the whole `PROXYWAR_REPLAY_PREMIERE_STATE_ROOT` directory, start
  clean. There is no partial-reset command; the catalog/event-store/archive are all rooted
  there.
- A premiere whose `scheduledAt` + nominal duration has already fully elapsed by the time
  you look at it will show `status: "settled"` immediately (the whole match "already
  happened" from the server's release-clock perspective) — re-admit with a fresh
  `scheduledAt` a little in the future rather than trying to "rewind" one.
- A server restart (or any real service gap) while a premiere is mid-flight, if it exceeds
  the ~60s outage tolerance in the release-clock spec, transitions the premiere to `failed`
  ("This premiere could not continue. Any open positions were voided and refunded.") —
  admit fresh again rather than restarting mid-run.

## 10. Enabling the crowd (MarketSim)

Not available yet. `PROXYWAR_WAGERING_ENABLED=1` turns on the market itself, but the
synthetic-bettor simulator (`MarketSim`'s slice, referenced in
`src/server/replay-premiere/wagering/simulation/**`) had not landed a runnable CLI/toggle
as of this session — `npm run premiere-wagering:demo-crowd` exists in `package.json` but
targets the deleted/superseded pari-mutuel `src/prediction/dev/playthrough.ts`-era design,
not the LMSR engine; it was not exercised here. **Gap, not worked around**: verify the
market moves under your own trades in the meantime (§11); MarketSim's own harness should
supersede this note once it lands.

## 11. Client route wiring (PariServer's real routes)

**No swap was needed.** `src/client/ReplayPremiereRuntime.ts` already calls
`POST /api/premieres/<id>/market-orders` and `GET /api/premieres/<id>/market` — the exact
literal paths PariServer confirmed as final (`ReplayPremiereHttp.ts` cases `market_order`/
`market_state`). The "known gap" in the original task brief was already closed by the time
this session started (PageWire/PariServer's IRC handoff already used the final paths, not
placeholders).

## 12. The "Joining live…" hang — root-caused and fixed (Unblock session)

**Root cause #1 (the one originally suspected, confirmed correct): an ambient
`/w1/lobbies` WebSocket, unrelated to the join-lobby event path.**
`GameModeSelector.ts` (the landing page's public-lobby-list widget,
`<game-mode-selector>`, present in the shared SPA shell on every route)
constructs a `PublicLobbySocket` and calls `.start()` unconditionally from
`connectedCallback()` the instant the custom element is upgraded — regardless
of the current route. `LobbySocket.ts`'s `PublicLobbySocket.start()` already
had a guard for this: `if (isAiLeagueReplayRoute()) return;`. That guard
(`AiLeagueReplayMode.ts`) already recognized `/premiere/<id>` via
`isReplayPremiereRoute()` — which is why `/premiere/<id>` never had this bug —
but had **no** case for `/bet/<id>`, so on the betting page the socket opened
every time. `ai-agent-demo-server.ts` runs no `/w1/*` worker infra at all (confirmed,
§0), so the handshake gets a 302 and fails immediately, and (via `joinLobby`'s
ordinary `Transport`, unrelated) is a complete red herring for the actual hang.
Fix: `AiLeagueReplayMode.ts` — added `isBettingPremiereRoute()`
(`/^\/bet\/prem_[a-z0-9]{16,32}$/`) and OR'd it into `isAiLeagueReplayRoute()`,
the single shared classifier every ambient landing-page subsystem (lobby
socket, ads, analytics, auth refresh, cosmetics) already gates on for
`/premiere/<id>`. One-line, matches the existing pattern exactly, no new
concept introduced.

**Root cause #2 (undiagnosed by the previous session — this alone still
hangs the page even with #1 fixed): the betting route never got the
client-side `CDN_BASE`/`__PROXYWAR_AI_REPLAY__` origin fallback, so the
progressive-replay worker's asset fetches fail to even parse a URL.**
`index.html`'s pre-hydration bootstrap script sets
`window.__PROXYWAR_AI_REPLAY__` from a hardcoded route-prefix list
(`/ai-league-replay/`, `/premiere/`, coworld routes, …) that also lacked
`/bet/`. That flag gates `window.CDN_BASE`'s fallback to `location.origin`
when no real CDN is configured (the local-dev case). Without it,
`window.CDN_BASE` stays `""`, which the client passes into the progressive-
replay `Worker` (`ReplayPremiereWorker.worker.ts`, an **inline `blob:` worker**
per `?worker&inline`) as `cdnBase`. Inside that worker, `assetUrl()` then
returns path-absolute (not fully-qualified) URLs like
`/_assets/maps/asia/manifest.<hash>.json`, and `fetch()` of a path-absolute
URL from a `blob:` base **fails to parse** in Chrome
(`TypeError: Failed to execute 'fetch' … Failed to parse URL from /_assets/…`;
confirmed empirically via `worker.evaluate` in this session — the manifest
itself was present and correct, `self.origin` inside the blob worker
correctly reports the real page origin, only the fetch call itself broke).
`createGameRunner()`'s map load rejects, the worker silently swallows the
real error and posts back `{type:"initialization_error"}` (no `console.error`
call — this is why nothing showed up in the browser console), and the client
surfaces a real `error-modal` ("Worker initialization failed") that a
`showErrorModal` side effect quietly relabels as the generic replay-load
veil failure. **This exact same latent bug affects `/premiere/<id>` too** —
it is not betting-specific, `Worker.worker.ts` (ordinary multiplayer/replay)
uses the identical `FetchGameMapLoader`/`assetUrl`/`cdnBase` pattern with the
identical comment about the CDN fallback; `/premiere/<id>` only avoided it in
this session's spot checks because `window.__PROXYWAR_AI_REPLAY__` already
covered `/premiere/`. Fix: `index.html` — added `/bet/` to the
`window.__PROXYWAR_AI_REPLAY__` route-prefix list (one line, same file, same
pattern as root cause #1's fix, just a different hardcoded route list this
session found by tracing the actual failing `fetch()` call rather than
trusting a config guess). Also fixes, as a side effect, the CSP-blocked
`crazygames-sdk`/`turnstile`/`googletagmanager`/`cloudflareinsights`
console-error noise from the previous session's console capture — those
scripts are gated on the same flag and now correctly skip loading on
`/bet/<id>`.

**Root cause #3 (found once #1+#2 unblocked the worker: the market poll
itself was broken): the client's `marketStateSchema` didn't match the wire
contract.** Once the replay actually loaded, the trade sidebar got stuck on
"Loading market…" with a visible `invalid_response` error. The live
`GET /api/premieres/<id>/market` response never included `premiereId` inside
`market` (verified via direct `curl` against a real running server, before
*and* after PariServer's in-flight rework — this was a pre-existing gap, not
something their change introduced) yet `marketStateSchema` (in
`ReplayPremiereRuntime.ts`) required it under `.strict()`, so **every** real
market response ever emitted by this server has always failed client-side
schema validation — this session is simply the first time a browser session
ever got far enough to exercise that code path. Separately, PariServer's
continuous-trading/read-ahead rework (landed live during this session, final
per their `hub` confirmation) added a required `market.liveVisibleSequence`
field and reshaped `Trade` (dropped `checkpointId`, added `participantKind`/
`sequence`/`idempotencyKey`) — both also unhandled by the pre-existing
schema. Fix, all in `src/client/ReplayPremiereRuntime.ts` +
`src/client/prediction/wagering/**` (NOT touching
`src/server/replay-premiere/wagering/**`, per the "coordinate, don't edit"
constraint):
  - Removed `premiereId` from `marketStateSchema` and its two now-dead
    comparison checks (`assertMarketStateBound`, the market-response bind
    check in `readMarketState`).
  - Added `liveVisibleSequence: nonNegativeIntegerSchema` to
    `marketStateSchema`; added `MarketState.liveVisibleSequence` to the
    client view type and its `serviceMapping.ts` passthrough.
  - `tradeSchema`: dropped `checkpointId`, added `participantKind`
    (`"real"|"synthetic"`), `sequence`, `idempotencyKey`.
  - `ReplayPremiereTradeRequest`: `checkpointId: string` →
    `sequence: number` (the freshest observed `market.liveVisibleSequence`,
    per PariServer's semantics — "always send the freshest value you have,
    don't cache a stale one across multiple orders"); `submitMarketOrder`'s
    validation/body-construction and `assertTradeResponseBound`'s bind check
    updated to match.
  - Removed the stale checkpoint-window gate from the controller-level
    `submitMarketOrder` (`ReplayPremiereRuntimeController`) — it looked up
    `request.checkpointId` in `publicDefinition.checkpoints` and rejected if
    that checkpoint's sequence was ahead of `observedSequence()` (the
    *replay-turn* clock, an unrelated concept to the *market's* live-visible
    clock). Continuous LMSR trading is explicitly, deliberately **not**
    gated to a checkpoint window (see `BettingOverlay.ts`'s own doc comment:
    "checkpoints are content beats the UI highlights, they gate nothing") —
    this gate was a checkpoint-era leftover that never got scrubbed when the
    continuous-market design landed, and would have permanently rejected
    every order once no real gate concept existed to satisfy it. The server
    is the sole remaining authority on sequence freshness (rejects a
    stale/ahead claim with `410 order_sequence_unreleased`).
  - `BettingOverlay`/`BettingPremierePage`/`TradeTicket` wiring: dropped
    `checkpointId` threading through `onTrade`; `BettingPremiereMarketController`
    now tracks `latestLiveVisibleSequence` from every poll/trade response and
    sends it fresh on each order.
  - Updated the 4 affected test fixtures (`tests/client/ReplayPremiereRuntime.test.ts`,
    `tests/client/prediction/wagering/{components,serviceMapping,validate}.test.ts`)
    to match the corrected wire shape. All 5 affected suites green (198 tests).

**Root cause #4 (found once the market poll worked: the trade ticket's seat
list was empty): `BettingOverlay.allSeats()`/`seatLabel()` sourced seats from
`model.checkpoints[].options`, which stays `[]` until a checkpoint's
prediction window opens — a concept continuous LMSR trading deliberately
doesn't use.** The market's own `outcomeSeatIds` (always populated) has no
display names attached; those live on `model.policies` (`ReplayPremiereOverlayModel.policies`,
always populated from admission-time provenance, independent of checkpoint
state). Fix: `BettingOverlay.ts` — `allSeats()` and `seatLabel()` now read
`this.model.policies` directly instead of walking `checkpoints[].options`.

All four fixes are pure client-side (`index.html`,
`src/client/AiLeagueReplayMode.ts`, `src/client/ReplayPremiereRuntime.ts`,
`src/client/prediction/wagering/**`) — zero diff under `src/core/**` or
`src/server/replay-premiere/wagering/**`. `npx tsc --noEmit` and
`npx eslint` are clean on every file this session touched (the only
remaining `tsc` errors anywhere in the repo are in
`tests/server/replay-premiere/**`, PariServer/MarketSim's own concurrent,
not-yet-typechecking WIP on their rework — confirmed by `git status`
showing those as the only other dirty files, unrelated to anything in this
section).

### Real command sequence used to reproduce + verify (local, isolated, this session)

```sh
# Isolated server on its own port/state-root — avoids colliding with any
# other agent's demo-server process (see §5's writer-lock note).
mkdir -p /Users/<you>/.proxywar-dev-unblock/replay-premiere
chmod 700 /Users/<you>/.proxywar-dev-unblock/replay-premiere   # required — the
  # server rejects a world/group-readable private-state-root with
  # `private_state_root_not_private` (503 PREMIERE_UNAVAILABLE) at boot.

GAME_ENV=dev PROXYWAR_WAGERING_ENABLED=1 \
PROXYWAR_PUBLIC_URL=http://127.0.0.1:8791 \
PROXYWAR_REPLAY_PREMIERE_STATE_ROOT=/Users/<you>/.proxywar-dev-unblock/replay-premiere \
PROXYWAR_LEAGUE_WRAPPER_ONLY=true AI_LEAGUE_DEMO_PORT=8791 \
npx tsx src/scripts/ai-agent-demo-server.ts
# NOTE: PORT= is NOT the right env var — the server reads AI_LEAGUE_DEMO_PORT
# (see ProxyWarDemoServerConfig.ts); PORT is silently ignored and the
# server falls back to the 8787 default, which will collide with any other
# demo-server process already using that port.
```

Re-admit with §6's admission command against `--deployment-origin=http://127.0.0.1:8791`,
restart the server, then:

```sh
curl -s "http://127.0.0.1:8791/api/premieres/<id>/market"
# {"schemaVersion":1,"market":{"outcomeSeatIds":[...4 ids...],"b":10,
#  "q":[0,0,0,0],"prices":[25,25,25,25],"status":"open","winnerSeatId":null,
#  "liveVisibleSequence":140,"positions":null}}
```

**Chrome, launched directly (not via `open -a`) for a real CDP endpoint:**

```sh
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --remote-allow-origins=* \
  --user-data-dir=/tmp/proxywar-chrome-profile-unblock \
  --no-first-run --no-default-browser-check &
curl -s http://localhost:9222/json/version   # NOTE: use "localhost", not
  # "127.0.0.1" — Chrome 150 binds the DevTools port on ::1 and 127.0.0.1
  # gets a bare 404 with no explanation.
```

**Local-only test workaround needed to reach `/bet/<id>` at all — not a code
bug, a consequence of this server topology never running behind its real
reverse proxy locally:** every anonymous premiere API write
(`POST /api/premieres/<id>/sessions`, and transitively every subsequent
authenticated call) resolves the requester's address via
`createReplayPremiereTrustedProxyAddressResolver` seeded with
`REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES` (127.0.0.1/::1) — i.e. it trusts
forwarding headers **only** from a loopback peer, exactly the shape of the
real production Cloudflare-tunnel deployment. A browser connecting directly
to `127.0.0.1:8791` (no tunnel in front, as in any purely local dev setup)
*is* a loopback peer, so the resolver looks for a forwarding header, finds
none, and returns `null` → every write 400s with `remote_address_unavailable`.
Set a header that simulates the tunnel to unblock local testing:

```js
await page.setExtraHTTPHeaders({ "CF-Connecting-IP": "203.0.113.42" });
```

(Puppeteer/CDP `Network.setExtraHTTPHeaders` — or any equivalent way to add
a static header to every outgoing request from the tab before navigating.)

### What was verified live in a real browser this session

- `/bet/<id>` loads all the way through: real replay renders (turn-accurate
  live territory map, standings table), **zero console errors** (one benign
  `Canvas2D willReadFrequently` perf warning only), the LMSR trade ticket
  renders with all 4 seats populated at 25.0 each, bankroll `1,000 cr`.
- **Buy, live, driven end to end**: selected a seat, entered a 150-chip
  budget, the client's own preview quote read *"Buy 5 sh of Aggressive
  Expander for 150 cr (avg 30.0). Price moves to 35.5."* — clicked "Buy
  shares" and the **actual** post-trade state matched that preview exactly:
  bankroll `1,000 → 850` (debited exactly 150), `market.q` became
  `[5,0,0,0]`, and live prices became `[35.47, 21.51, 21.51, 21.51]`
  (LMSR redistribution across the other 3 seats) — the bought seat's price
  moved to within rounding of the quoted 35.5.

### What was NOT reached — genuinely out of session budget, not worked around

- **Sell, hold-to-settlement, bankroll reconciliation, the synthetic crowd,
  and reload-survival were not driven live.** The session ran out of budget
  immediately after the verified buy above.
- **A real, separate gap found but not fixed**: `BettingPremiereMarketController`
  applies every poll response (an *anonymous* `GET /market`, where
  `positions` is always `null` per PariServer's contract) over the
  overlay's `market` property unconditionally. A `POST /market-orders`
  response *does* carry the acting participant's real positions, so
  "Your positions" briefly would be populated right after a trade — but the
  very next poll (every 2.5s) overwrites it back to `null`, so the positions
  panel and unrealised-P&L display cannot durably show anything. Confirmed
  live: after the successful buy above, "Your positions" still read "No open
  positions." Smallest fix: `BettingPremiereMarketController.applyMarket`
  should merge — keep the last known non-null `positions` for a seat when a
  fresh anonymous poll reports `null`, replacing it only when a POST
  response (or a future authenticated poll, if one lands) actually carries
  real position data. Not attempted this session — needs the same care given
  to the sequence-freshness fix above and there was no budget left to do it
  safely.
- PariServer flagged mid-session that a new `readLiveProjection`-backed
  content route is coming for the betting page specifically (to bound how
  far ahead of `authoritativeElapsedMs` a client can trade) — not built yet
  as of this session's end; the betting page still consumes the same chunk-
  release route `/premiere/<id>` uses. Follow up with PariServer once that
  lands.
- Registering more than ~2 premieres against the same
  `PROXYWAR_REPLAY_PREMIERE_STATE_ROOT` in quick succession without a full
  reset (§9) sometimes leaves a freshly-admitted premiere unregistered after
  restart (`operatorCode=premiere_not_registered`) even though its
  `<id>.admission.json` is present in `catalog-v1/entries/`. Worked around
  by re-admitting with a fresh id and confirming via `curl` before opening
  a browser; root cause not investigated (budget), but it reproduced
  consistently enough in this session to be worth flagging rather than
  assuming it was a one-off.
