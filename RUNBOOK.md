# Proxy War Replay Premiere + Live Betting — local runbook

Status as of this session (Finish): the client-side wagering module now has
**exactly one bankroll authority — the server** (`market.balance` off
`GET .../market/me`, an authenticated participant read landed by
PariServer this session). `SessionBankroll` (the old client-local
debit/credit/payout ledger) is deleted; `BettingPremiereMarketController`
is a pure passthrough of server-reported `balance`/`positions`, reconciled
fresh on every poll and every trade response, with zero local money
arithmetic anywhere in `src/client/prediction/wagering/**`. Two real,
load-bearing bugs were found and fixed live (not in a unit test) this
session, both outside the wagering module proper but required to make it
actually work in a real browser — see §13 for the full account, the exact
evidence, and the one confirmed-but-unresolved gap (a settlement-timing
race that can still falsely show "This premiere could not continue" on a
passively-polling tab, only partially fixed this session — §13.3).
Previous sessions' content (§0–§12) is unchanged and still accurate.

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

Turn count/turn-interval matter: the server enforces a **hard 128-chunk ceiling**
per premiere (`REPLAY_PREMIERE_MAX_CHUNK_COUNT`, `maxPresentationSpanMs <=
60,000ms` per chunk by default) regardless of whether wagering is on — an
earlier wagering-specific 1s-per-chunk ceiling existed for one session and was
reverted; there is no wagering-specific cap anymore. So `turnCount *
turnIntervalMs` just needs to stay well under `128 * 60,000ms` (~2h08m) for the
default chunking to apply. A real 4-agent FFA on Asia/Compact with alliances
disabled took 10,800 turns to produce a winner in this session — use
`--playback-turn-interval-ms=10` to keep nominal duration at 108s, which also
keeps the demo brisk to watch. Real observed run:

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
  --nonce-file=/private/tmp/proxywar-premiere-admit-inputs/nonce.bin
```

`--max-presentation-span-ms` is an optional CLI flag on `replay-premiere-admit.ts`.
**It is no longer required for wagering.** A wagering-specific 1s-per-chunk ceiling
existed for one session and was reverted; `WAGERING_MAX_PRESENTATION_SPAN_MS` and the
`wagering_presentation_span_exceeded_ceiling` error code no longer exist in the code.
Wagering premieres now use the same general `REPLAY_PREMIERE_MAX_CHUNK_COUNT` (128) and
60s-span ceiling as everything else, so the script's 45s default span is fine and the
flag can be omitted entirely. Pass it only if you deliberately want finer chunking.

Real successful output from this session:

```json
{"premiereId":"prem_asvlm54vtb1oa57ulfcd","sourceRunId":"local-dev-premiere-2","sourceReplaySha256":"8eed82b5bc1a727e4e63097ed7a26e3c86d5c1ebff8c4c6eb4df37875b45ac34","eligibilityRecordHash":"9cd24f9dec4b98ded0ad70ca571db1a0015c6051e64c756d55d26bdc921bdc78","publicationCommitmentHash":"84c098b977f76415e1b2f6793888f154c6c5d42215c7b6e07a39c2e1d1413843","orderedDraftManifestRoot":"0e17acb3c2de3e237ab0cc5fb5d8ccc161728736e3e49dbc69553e638fcd7e11","admissionRecordHash":"7b047c35f170cf18913837686426a3ca798dec0ab6b1cae0ac45288138e0a62e","deploymentOriginSha256":"b1a61bf29a38ff3642af0dad0785e1677a58232f2e9bb85db3f7a80d8bf1a387"}
```

## 7. Activate it

Admission never hot-registers; the server must restart and reconstruct its catalog:

```sh
# Ctrl-C the server from §5, then start it again with the same env vars.
```

The same applies to **client** changes, and it is easy to lose an hour to:
`npx vite build` writes a fresh `static/assets/index-<hash>.js`, but the
server caches `index.html` in memory at boot, so it keeps serving the *old*
hash until it restarts. Cache-busting the URL in the browser does not help —
the stale reference is coming from the server, not the browser.

To check what is actually live rather than what you built:

```sh
ls static/assets/index-*.js | head -1                       # on disk
curl -s https://bet.proxywar.xyz/account \
  | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1    # being served
```

Different hashes mean your build has not gone live yet. On the hosted deploy
the autocycler restarts the origin on every cycle, so it lands within ~25
minutes on its own.

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

`PROXYWAR_WAGERING_ENABLED=1` turns on the market; `PROXYWAR_SYNTHETIC_CROWD_ENABLED=1`
(requires wagering on) additionally starts `SyntheticCrowdLiveDriver`
(`src/server/replay-premiere/wagering/simulation/**`) against the real running
premiere — see §13.5/§13.6 below for the exact env block and verification. That
is the real, end-to-end way to see the crowd trade.

Separately, `npm run premiere-wagering:demo-crowd` (`src/scripts/premiere-wagering/
demo-synthetic-crowd.ts`) runs the same LMSR crowd/pricing math standalone,
in-process, against a small self-contained fixture — no server, no browser.
Useful as a fast sanity check of the pricing math alone; it does not exercise
the live driver, the HTTP layer, or the real premiere/order pipeline, so it is
not a substitute for §13.5/§13.6 below.

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

## 13. Single bankroll authority + the live walkthrough (Finish session)

### 13.1 Client change: one source of truth

`src/client/prediction/wagering/sessionBankroll.ts` (and its test) are
**deleted**. `BettingPremiereMarketController`
(`page/BettingPremierePage.ts`) now polls the new authenticated
`GET .../market/me` (`ReplayPremiereRuntimeController.readMarketSelf()`,
new this session, mirrors `readMarketState()` but authenticated) instead of
the anonymous `GET .../market`, and applies every response — poll, trade,
or stale-sequence re-quote — as a **verbatim passthrough**:
`overlay.market = market; overlay.bankroll = market.balance;`. No local
debit/credit/payout math anywhere. `MarketState.balance: number | null`
(new field, `serviceMapping.ts`/`ReplayPremiereRuntime.ts` schema) carries
the server's own `market.balance` straight through. `validate.ts` already
took `bankroll` as a plain input — no change needed there, the caller just
feeds it a different (now-correct) number. `positionsFor`
(`ReplayPremiereMarket.ts`, server-side, see §13.2) had a real gap where a
settled market's positions came back empty for everyone; fixed this
session so `/market/me` keeps reporting real, non-empty positions
(final shares/cost basis, real payout) after settlement too — the
`BettingPremiereMarketController` needs no settlement-specific
client-side caching or fallback as a result.

### 13.2 Two real bugs found live, not by any unit test — both fixed this session

**Bug 1 — `GET .../market/me` 403'd for every real browser, always.**
`market_state_self`'s handler called the same `authorizeWrite()` every
write route uses, which unconditionally requires an `Origin` header. Real
Chrome (confirmed at the wire level via CDP `Network.
requestWillBeSentExtraInfo` — NOT `Network.requestWillBeSent`, whose
`request.headers` silently omits browser-injected headers like `Origin`
and gives a false negative) sends `Origin` on a same-origin **POST**
(hence `market-orders`/`sessions`/`heartbeat` all worked) but **never**
sends `Origin` on a same-origin **GET/HEAD** fetch — this matches the
Fetch standard, is not a bug in the browser, and `Origin` is a forbidden
header no page script can set to work around it. Every previous "verified
live buy" in this RUNBOOK was a POST and never exercised this path, so it
was never caught before this session. Fixed by PariServer:
`ReplayPremiereGuestSecurity.authorizeAuthenticatedRead()`, a GET-
appropriate sibling of `authorizeWrite()` — checks `Origin` with the exact
same strictness when present, falls back to `Sec-Fetch-Site: same-origin`
(what Chrome actually sends) or `Referer` when `Origin` is legitimately
absent. `authorizeWrite()` itself is untouched; every write route's
Origin requirement is unchanged.

**Bug 2 — a trade landing in the last moments of a match could falsely
show "This premiere could not continue. Any open positions were voided
and refunded" even though the server settled normally.**
`ReplayPremiereRuntimeController.submitMarketOrder()` had a hard
`this.reveal === null && response.market.status === "settled"` check that
`latchFailure("integrity_failure")`s unconditionally. Checkpoint pauses
are bypassed for wagering premieres (the whole point — continuous
trading), so the replay races straight through to the true end with none
of the breathing room a normal premiere's final checkpoint pause gives the
verified-reveal fetch to land first. A trade whose response lands in that
exact window (server-authoritative market settlement, ahead of the
client's own reveal fetch) tripped this check even though nothing was
actually wrong. Fixed by reusing the same `isRevealVerificationPending()`
distinction `sendHeartbeat` already relies on for this identical race:
only latch a hard failure when the replay's own state machine doesn't
*also* think the match could be over — i.e., a genuinely inexplicable
claim, not an ordinary delivery race. Verified: `tsc --noEmit`, `eslint`,
and the full suite (296 files / 3485 passed) all clean after this change.

### 13.3 Known gap — NOT fixed this session, reproduces on the passive poll path too

**The exact same class of false "could not continue" failure was observed
four separate times purely from the automatic heartbeat/poll loop, with
zero trade ever submitted** — i.e. §13.2's Bug 2 fix (scoped to
`submitMarketOrder`) does not cover every trigger. `ReplayPremiereRuntime.ts`
has roughly a dozen other `latchFailure("integrity_failure")` call sites
(frame processing, reaction/clip response binding, the heartbeat error
handler at large) and at least one of them is being tripped by this same
reveal-delivery race during the ordinary heartbeat cadence, near the
natural end of a wagering premiere specifically (checkpoint-bypass is what
removes the breathing room every other call site implicitly relied on).
**Every single wagering-premiere run this session reached this failure
state exactly once, right around natural settlement** — confirmed via
direct `curl` each time that the *server's* own `/market` endpoint showed
`status: "settled"` with a real `winnerSeatId`, never `"failed"`; the
premiere genuinely completed normally every time, only the client's own
display went wrong. This was diagnosed down to "some `latchFailure` call
site is racing reveal delivery, exactly like §13.2's confirmed instance,"
but which exact site (or sites) was still being isolated (via a temporary
`console.error` in `latchFailure` logging `new Error().stack`, removed
before this session ended — not shipped) when this session's time ran
out. **This is the one item genuinely blocking a clean end-to-end
recording of the full walkthrough (steps 6-9 below) — everything up to
and including a live, crowd-driven buy was verified; sell/reload/second-
tab/hold-to-settlement were not reached cleanly because every run's
available live window kept getting consumed by (a) this bug's own
diagnosis and (b) join-sync taking 20-40+ real seconds to catch up to
live under this machine's multi-agent CPU contention, eating most of the
~108s match window before any interaction could start.** The fix shape is
known (apply the same `isRevealVerificationPending()` guard to whichever
call site is actually firing, the same way §13.2 was fixed) — it just
wasn't isolated and landed in time.

### 13.4 What was verified live this session (real browser, real server, real crowd)

- `/bet/<id>` with `PROXYWAR_SYNTHETIC_CROWD_ENABLED=1` (see §13.5): loads
  to a rendering replay, zero *wagering-specific* console errors (the
  CrazyGames/Turnstile/GTM/YouTube CSP-blocked script-tag noise from §12
  is present on every route including plain `/premiere/<id>` — it is a
  site-wide, pre-existing, unconditional `<script src>` tag in
  `index.html`, not gated by any JS route flag despite an earlier
  session's note to the contrary; out of scope for this session, tracked
  here rather than silently ignored).
- Bankroll badge read `1,000 cr` **off `market.balance` via `/market/me`**
  (server-authoritative, not a client default) the instant the trade
  ticket rendered.
- **Synthetic crowd moved prices with zero human trading**: prices
  diverged from the 25.0/25.0/25.0/25.0 baseline (observed 13.7/13.7/50.1/
  22.5 on one run) before any trade of mine landed — confirmed both
  visually (price board) and via direct `curl` (`market.q` non-zero from
  crowd activity alone).
- **A real buy, submitted through the actual trade ticket UI** (seat
  click → budget input → submit click, not a direct API call): quoted
  "4 sh of Aggressive Expander for 117 cr, avg 29.3" but — because the
  synthetic crowd kept trading in the ~2-3s between quote render and the
  click reaching the server — actually filled 5 sh for 147 cr. Bankroll
  debited **exactly** 147 cr (1,000 → 853), matching the trade response's
  own `chips` figure exactly, not the stale quote. This is correct,
  designed behavior under a live crowd (the `limitPrice` sent with every
  order is what protects against a materially worse fill, not a promise
  that quote and fill are byte-identical when the book is moving) — worth
  recording plainly since it is a real, reproducible divergence from a
  literal "fill matches the quote" reading, and the crowd being on is
  what surfaces it. A fast, low-latency click sequence would be expected
  to match cleanly against a slower-moving book; not reproduced cleanly
  this session due to the time spent isolating §13.3.
- Not reached this session (blocked by §13.3, not attempted-and-failed):
  unrealised P&L development, sell, reload-survival, second-tab
  agreement, hold-to-settlement reconciliation, narrow-viewport pass.
  These are the concrete remaining acceptance items for whoever picks up
  §13.3's fix.

### 13.5 Enabling the synthetic crowd (supersedes §10's "not available yet")

```sh
PROXYWAR_SYNTHETIC_CROWD_ENABLED=1   # alongside PROXYWAR_WAGERING_ENABLED=1 — requires it
```

Real env block used this session (isolated port/state-root, same discipline
as §5's writer-lock note — every concurrent agent on this machine needs its
own port AND its own `PROXYWAR_REPLAY_PREMIERE_STATE_ROOT`):

```sh
GAME_ENV=dev \
PROXYWAR_WAGERING_ENABLED=1 \
PROXYWAR_SYNTHETIC_CROWD_ENABLED=1 \
PROXYWAR_PUBLIC_URL=http://127.0.0.1:8793 \
PROXYWAR_REPLAY_PREMIERE_STATE_ROOT=/Users/<you>/.proxywar-dev-<name>/replay-premiere \
PROXYWAR_LEAGUE_WRAPPER_ONLY=true AI_LEAGUE_DEMO_PORT=8793 \
npx tsx src/scripts/ai-agent-demo-server.ts
```

No separate confirmation log line — verify indirectly via `curl .../market`
showing `q` go non-zero with nobody trading, or a live price board moving
on screen before any click.

### 13.6 State reset between runs — real gotchas hit this session, beyond §9

- **Canonical timestamp format is exact-ISO-milliseconds, not
  microseconds.** `externalEmbargoEvidence[].observedAt` and
  `definition.scheduledAt` are validated via
  `new Date(Date.parse(value)).toISOString() === value` — JS's
  `toISOString()` always emits exactly 3 fractional digits. Python's
  `datetime.isoformat()` defaults to 6 (microseconds) and fails admission
  with `external_embargo_invalid_timestamp` even though the timestamp is
  otherwise fresh and valid. Use
  `datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")`.
- **The server must already be running (with the correct
  `PROXYWAR_PUBLIC_URL`/`PROXYWAR_LEAGUE_WRAPPER_ONLY=true`) *before* you
  run `replay-premiere-admit.ts`**, not just before you restart it
  afterward — the admit script's leak-audit collector makes a real HTTP
  request against the deployment origin during admission itself, and
  fails closed (`premiere_leak_collector_request_failed`) if nothing is
  listening yet.
- **Reuse one generated `.source.json` bundle across many admissions.**
  Regenerating costs a real ~70s wall-clock run; the bundle is immutable
  content keyed by its sha256, so admitting the SAME bundle under a fresh
  `--premiere-id` + fresh `scheduledAt` is the fast path for repeated live
  runs (this session admitted 6 premieres off one bundle).
- **Give real lead time on `scheduledAt`.** Anything under ~30s risks the
  join-sync/asset-load pipeline (12-40+ real seconds observed this
  session, worse under multi-agent CPU contention) eating into or past
  the scheduled start before the tab even finishes its initial join,
  wasting the live window before any interaction is possible.
- **A restart with no admission pending is a fast no-op** (~1-2s) — safe
  to restart liberally when only re-registering an already-admitted
  premiere, no need to tear down and recreate the state root each time
  within one working session (only §9's full-directory-delete applies
  between genuinely separate sessions/branches).

## 14. The false "could not continue" fix, and what's still open (EndRace session)

### 14.1 Root-caused and fixed: `applyServiceProjection` was the real trigger

§13.3's diagnosis (a `latchFailure` call site racing reveal delivery) turned
out to be half right and half a red herring, isolated this session with a
crash-safe `console.error(new Error().stack)` inside `latchFailure()` (the
first, careless version of that same diagnostic — logging
`this.currentNetworkState()`, which does an unchecked `this.projection!`
read — itself threw when `latchFailure` fired before `this.projection` was
set, got swallowed by `ReplayPremiereNetworkController.invokeCallback`'s
catch-and-rethrow, and cascaded into a *second*, corrupted failure. That
cascade is what produced this session's first several "reproductions" —
worth flagging so nobody re-walks that exact trap. The fixed, exception-safe
version confirmed the real site).

**Real bug**: `ReplayPremiereRuntimeController.applyServiceProjection()`
(`src/client/ReplayPremiereRuntime.ts`) — called from both `sendHeartbeat`
and `bootstrapInteractions` — checked
`this.reveal === null && hasOutcomeProjection(response.checkpoints)` and
latched `integrity_failure` unconditionally, with no
`isRevealVerificationPending()` exemption. Checkpoint pauses are bypassed
for wagering premieres, so a heartbeat response can legitimately carry an
outcome-bearing checkpoint before the verified reveal has landed
client-side — the exact same race `submitMarketOrder` was already fixed for
in the Finish session. Fixed the same way: only latch when
`!isRevealVerificationPending()`. A lifecycle mismatch
(`!isLifecycleCompatible(...)`) in the same function is a **different,
always-genuine** signal (e.g. a regression to `"draft"`) and was
deliberately left unconditional — narrowing the guard to exactly the
outcome-ahead-of-reveal case, not the whole function, is what an existing
test (`does not fence a $label behind a reveal pointer`) was already
pinning down; it stayed green. `onPrediction`'s callback
(`overlayCallbacks()`) had the identical unguarded pattern for a checkpoint
prediction response and got the same fix.

Regression tests: `tests/client/ReplayPremiereRuntime.test.ts` →
`"wagering premiere reveal-delivery race (natural end, checkpoint pauses
bypassed)"` — one test proves a heartbeat carrying the match's outcome
while the reveal is still in flight reaches `revealed` without ever
latching; the sibling test proves the same outcome-bearing heartbeat still
latches `integrity_failure` when nothing else explains it (no reveal
pointer, network state still plainly `"playing"`). Verified the first test
fails against the pre-fix code and the second passes either way (real
regression coverage, not a vacuous assertion).

### 14.2 A second, independent, 100%-reproducible bug found via live diagnosis

Every heartbeat/session-create call for a wagering (`contentSource: "tap"`)
premiere 400'd with `PREMIERE_INVALID_REQUEST` /
`observed_sequence_unreleased` — **every single heartbeat, every run,
starting with the very first one** — a real, visible console error every
10s that alone would have failed the walkthrough's "zero console errors"
bar. Root cause: `assertAuthoritativeObservedSequence`
(`src/server/replay-premiere/ReplayPremiereInteractions.ts`) validated the
client's `observedSequence` against `getReleasedContext`'s
`lastSafeReleasedSequence` — a coarse, chunk-release-action counter correct
for `contentSource: "chunks"` clients. A `contentSource: "tap"` client (the
betting page) legitimately reports a fine-grained per-turn
`observedSequence` instead (`latestFrame.sequence`), which vastly
outpaces the coarse counter within about a second of match start. Fixed by
PariServer (this session, coordinated live over `hub`) by additionally
accepting `sequence <= this.getLiveVisibleSequence()` — the same
authoritative, per-turn bound `submitMarketOrder` already trusts — before
falling back to the original coarse check; pure widening, `chunks`-mode
premieres are untouched. A second, separate widening was needed (also
PariServer, same session) in `assertSnapshotObservedSequence` — the
recovery-time validator run on every server restart — otherwise a session
accepted live under the new wide bound would fail to reconstruct the next
time the server restarted. Regression test:
`tests/server/replay-premiere/wagering/ReplayPremiereObservedSequenceRecovery.test.ts`.

### 14.3 What was and wasn't verified live this session

With both fixes applied, 6 of 7 live natural-end runs (own isolated
server/port/state-root, synthetic crowd on) reached `revealed` cleanly —
**zero console errors**, no false failure, confirmed via direct `curl`
against `/market` (`status: "settled"`, real `winnerSeatId`) and
`/manifest` (`state: "revealed"`) at the same instant. **One run out of
seven still showed "This premiere could not continue"** after both fixes,
confirmed via a crash-safe diagnostic in both `latchFailure()` and
`onTerminal()` to have latched **neither** `terminalFailure` **nor** a
`networkTerminalState` of `"failed"`/`"cancelled"` — i.e. not reproducible
via any code path this session could find or explain, and not reproduced
again in three further attempts with the same diagnostic active. Given this
machine consistently runs several other agents' demo-server processes
concurrently (`ps aux` showed 3-4 unrelated `ai-agent-demo-server.ts`
processes throughout this session), a genuine, real, one-off service
hiccup under multi-agent CPU contention (exactly the confound §12/§13
already flag repeatedly) is the leading explanation, but this is
**stated plainly as unconfirmed, not swept under the rug**: whoever next
hits this should re-run the SAME crash-safe `console.error` pattern in both
`latchFailure()` and `onTerminal()` (both removed cleanly this session,
confirmed via `grep -n "TEMP DIAGNOSTIC" src/client/ReplayPremiereRuntime.ts`
returning nothing) on an isolated, otherwise-idle machine to rule out
environmental contention definitively.

**The full 9-step live walkthrough (buy/sell/reload/second-tab/settlement/
narrow-viewport) was NOT completed this session** — diagnosing and fixing
§14.1/§14.2 consumed the session's tool budget. `tsc --noEmit`, `eslint`
(zero new warnings/errors on every file touched), and the full suite
(297+156 files, 3489+1858 tests, 3 pre-existing todo) are all green as of
this session's last commit. Steps 1-2 (page load, zero console errors,
crowd-driven price movement) were re-confirmed working; steps 3-9 (buy,
P&L, sell, reload, second tab, settlement, narrow viewport) remain to be
driven live by whoever picks this up next — nothing about them is known to
be broken, they simply weren't exercised this session.

## 15. GitHub OAuth app registration recipe (GitHubAuth session)

"Sign in with GitHub" landed this session (per-premiere P&L ledger migration,
`ReplayPremiereIdentityLinkStore`, the three `/api/premieres/auth/github/*`
routes, and the client control). It needs one real GitHub OAuth App
registered by hand — I (the agent) cannot do this; it needs your GitHub
account. Everything below is exact, verified against the actual code paths,
not guessed.

### 15.1 Register the app

Go to `https://github.com/settings/applications/new` (a personal **OAuth
App**, not a GitHub App — no installation/webhook machinery needed) and fill
in:

| Field | Value |
|---|---|
| Application name | `Proxy War Betting` (anything recognizable; shown to the user on GitHub's consent screen, never in-product) |
| Homepage URL | `https://bet.proxywar.xyz` |
| Authorization callback URL | `https://bet.proxywar.xyz/api/premieres/auth/github/callback` — **exact**, see §15.2 for why |
| Enable Device Flow | Leave unchecked — not used |

**Scopes: none beyond GitHub's default.** Do not check or request `user:email`
or any repo/org scope. The product only ever needs `id`, `login`, and
`avatar_url` — all present on the unscoped `GET /user` response for the
authorizing user. The code literally never asks for a scope: see
`buildAuthorizeUrl` in `src/server/replay-premiere/ReplayPremiereGithubAuth.ts`
— no `scope=` parameter is set on the authorize URL at all. Requesting
`user:email` would additionally require a second `GET /user/emails` call and
a real privacy justification the product doesn't have (nothing here ever
shows or stores an email).

Registering produces a **Client ID** (public, safe to appear in a redirect
URL) and a **Client Secret** (generate one via "Generate a new client
secret" — copy it immediately, GitHub only shows it once).

### 15.2 Why the callback URL is exactly `https://bet.proxywar.xyz/...`

The deploy is a local process behind a Cloudflare tunnel — GitHub redirects
the **browser**, not the server, so the callback must be the public HTTPS
origin, never a loopback address, and it is: `createReplayPremiereGithubAuthRouter`
builds `redirect_uri` as `` `${publicOrigin}/api/premieres/auth/github/callback` ``,
where `publicOrigin` is the exact same `replayPremierePublicOrigin` value
(`new URL(PROXYWAR_PUBLIC_URL ?? localUrl).origin`) every other Replay
Premiere surface already uses for its strict-Origin CORS check and session
bootstrap (`ReplayPremiereGuestSecurity.expectedOrigin`). Nothing in the
OAuth handlers reads `req.socket`, a forwarded-header, or any tunnel-internal
address. So: whatever `PROXYWAR_PUBLIC_URL` is already set to for
`bet.proxywar.xyz` (per §5 above) is what gets sent to GitHub as
`redirect_uri` — confirm it is `https://bet.proxywar.xyz` (no trailing
slash, no port) before registering, and the registered callback URL must
match it exactly plus the `/api/premieres/auth/github/callback` suffix.
GitHub rejects a redirect_uri that doesn't exactly match a registered
callback, so a mismatch here fails closed (a stub-server 400/redirect
mismatch page), never a silent misroute.

### 15.3 Where the resulting values go

Three environment variables on the `bet.proxywar.xyz` origin process — the
exact same one that already carries `PROXYWAR_WAGERING_ENABLED`,
`PROXYWAR_PUBLIC_URL`, etc. (§5). The client secret has two forms —
**prefer the file form on any shared machine**: `ps eww <pid>` dumps a
process's entire environment to anyone with an account on the host, so an
exported `_CLIENT_SECRET` is one command away from being read by another
user. A file path costs nothing and keeps the secret at rest instead:

```
PROXYWAR_GITHUB_OAUTH_CLIENT_ID=<the Client ID>

# Preferred: a 0600 file holding just the secret. Write it with printf,
# NOT echo — echo appends a trailing newline that becomes part of the
# "secret" verbatim, and GitHub then rejects the token exchange with an
# opaque error that looks nothing like "your secret has a newline in it".
# (resolveGithubOAuthClientSecret trims trailing whitespace/newlines
# defensively, but don't rely on that — write it clean.)
printf '%s' '<the Client Secret>' > ~/.proxywar-deploy/github-oauth-client-secret
chmod 600 ~/.proxywar-deploy/github-oauth-client-secret
PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE=~/.proxywar-deploy/github-oauth-client-secret

# OR, local dev only — inline, used ONLY when _CLIENT_SECRET_FILE is unset:
PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET=<the Client Secret>
```

All three are read once at process start
(`resolveReplayPremiereGithubOAuthConfig` in `ReplayPremiereGithubAuth.ts`).
**The client id, plus one working form of the secret, must be present for
the feature to exist at all** — if the id is missing/blank, or the secret
is missing/blank/unreadable (file path set but the file doesn't exist or
isn't readable), the three `/api/premieres/auth/github/*` routes are never
mounted (not 404'd by a runtime check — genuinely absent from the Express
router chain), so a missing config means no button client-side and no
route to hit server-side, exactly the "cleanly not exist" contract. An
unreadable secret file logs only `GitHub OAuth client secret file
unreadable at <path>` — never the file's contents, never a raw fs error
that could embed unrelated data. The secret itself is read only
server-side for the `POST /login/oauth/access_token` exchange; it is never
logged, never included in any response body, and never reaches the
browser. A process restart is required after setting/changing any of
these (same as every other env var this server reads at boot — no
hot-reload path exists for any of them).

### 15.3a On the hosted deploy, write two files — don't set env vars

On `bet.proxywar.xyz` the origin's environment is built by
`cycle-premiere.sh`'s `start_origin`, which is re-run by the autocycler on
every match. Exporting a variable in your shell would be lost at the next
cycle, so **both values are read from files** and the script passes them in:

```sh
printf '%s' '<the Client ID>'     > ~/.proxywar-deploy/github-oauth-client-id
printf '%s' '<the Client Secret>' > ~/.proxywar-deploy/github-oauth-client-secret
chmod 600 ~/.proxywar-deploy/github-oauth-client-secret
```

That is the whole configuration step. `§15.3`'s three environment variables
are still what the *server* reads; these two files are how this deploy
supplies them. Note the asymmetry: `PROXYWAR_GITHUB_OAUTH_CLIENT_ID` is
passed by **value** because it is public, while the secret is passed as
`..._CLIENT_SECRET_FILE` — a **path** — so it never enters the process
environment where `ps eww <pid>` would expose it.

**The `chmod 600` is enforced, not advisory.** The resolver `lstat`s the file
and refuses it unless it is a regular file, owned by the running uid, with no
group or world bits — a symlink to a world-readable file is rejected too. A
loose secret fails closed exactly like a missing one, so if sign-in stays
invisible after registering, check the mode before anything else.

Takes effect on the next cycle (~25 min), or immediately if you restart the
origin. Until then the three routes are genuinely absent and the client
renders no sign-in control — that is the correct unconfigured state, not a
fault.

### 15.4 Verifying after registration

```sh
curl -sI https://bet.proxywar.xyz/api/premieres/auth/github/start
# expect: HTTP/2 302, location: https://github.com/login/oauth/authorize?client_id=<id>&redirect_uri=https%3A%2F%2Fbet.proxywar.xyz%2Fapi%2Fpremieres%2Fauth%2Fgithub%2Fcallback&state=...&allow_signup=false
```

If instead you get a 404 with `PREMIERE_UNAVAILABLE`, the env vars are not
set on that process (or the process wasn't restarted after setting them).
Then click through a real sign-in from `https://bet.proxywar.xyz/bet` — the
header shows a "Sign in" control (amber, matching the existing CTA
convention); after authorizing, it redirects back and the same spot shows
"Signed in as `<your GitHub handle>`", and your leaderboard row (once you've
traded at least one settled premiere) carries a small GitHub-mark badge
next to your VERIFIED handle instead of any self-claimed display name.

### 15.5 What this session tested instead of real GitHub (and why it's better for this)

No real GitHub OAuth App was registered this session (agents cannot create
one against your account, and were told not to try). All server-side OAuth
logic — `ReplayPremiereGithubAuth.ts` — is built against an injectable
`ReplayPremiereGithubOAuthClient` interface, plus two dev/test-only base-URL
overrides (`PROXYWAR_GITHUB_OAUTH_WEB_BASE_URL`,
`PROXYWAR_GITHUB_OAUTH_API_BASE_URL`) that point the real HTTP client at a
faithful local stub of `/login/oauth/authorize`, `/login/oauth/access_token`,
and `/user` instead of the real GitHub hosts. This is strictly MORE testable
than real GitHub for the required adversarial cases: renamed handle, two
truly concurrent callbacks for one GitHub id, and "provider unreachable"
are all reproducible on demand against a stub, never on demand against
GitHub's real infrastructure. See `tests/server/replay-premiere/ReplayPremiereGithubAuth.test.ts`
(HTTP-level, real Express router + real cookies, stub OAuth client) and
`tests/server/replay-premiere/points/ReplayPremiereIdentityLinkStore.test.ts`
(the concurrency/merge/rename cases in isolation). A real click-through
against the same stub, in a real browser, against a real locally-running
copy of this server, was also driven live this session — see the final
session report for the exact steps and screenshots.

## 16. The platform origin, and the two things only you can do (Platform session)

Identity used to be a betting feature: accounts lived under `/api/premieres/*`
on `bet.proxywar.xyz`, behind `PROXYWAR_WAGERING_ENABLED`, with a host-only
cookie scoped to the betting origin. That was backwards. Accounts are for all
of a user's models and policies, so they cannot exist only where wagering does.

### 16.1 What now runs where

| Origin | Port | Owns | launchd label |
|---|---|---|---|
| `proxywar.xyz` (apex) | 8793 | accounts, GitHub OAuth, display names, lineage claims, player profiles | `com.proxywar.platform` |
| `app.proxywar.xyz` | 8793 | nothing — 302s to the apex (see 16.2) | (same process) |
| `bet.proxywar.xyz` | 8792 | the market, points ledger, guest bankrolls | `com.proxywar.betautocycle` |
| `beta.proxywar.xyz` | 8788 | the league ladder and replays | (pre-existing) |
| `www.proxywar.xyz` | — | edge 301 to `beta.../league` (zone rule "www to league") | (Cloudflare) |

`com.proxywar.platformleague` keeps the platform's own copy of the league
mirror fresh. It exists because the platform must not depend on the betting
cycle running — betting was stopped once and the platform's standings froze
silently. Each service refreshes its own mirror.

Each origin keeps its own host-only cookie. The betting cookie was NOT widened
to `Domain=.proxywar.xyz`: a domain cookie lets any sibling origin overwrite
platform identity. Instead the two are linked by a **one-time opaque handoff
code**, redeemed server-to-server and consumed atomically. Query strings leak
through history, server logs, and `Referer`, and "one-time" cannot be enforced
by a signature — hence a code, not a signed token.

**The handoff is LIVE on `bet.proxywar.xyz` as of 2026-08-02 (superseded —
see §17.5).** Operator, 2026-08-02: "implement identity handoff for
betting" — the 2026-07-30 hold below is lifted. `PROXYWAR_PLATFORM_ORIGIN`
is now set in `cycle-premiere.sh`'s `start_origin()` (commit `548e9088b`),
which mounts the three `/api/premieres/auth/handoff/*` routes (the `else if
(configuredPlatformOrigin !== undefined)` branch in
`ai-agent-demo-server.ts`). Verified live end-to-end: `GET
/api/premieres/auth/handoff/start` → 302 to the platform → platform mints
an account + code → 302 back to `/api/premieres/auth/handoff/callback` →
redeemed → `platformLinked: true`; a replayed code correctly fails
(`already_redeemed`, one-time enforced). Historical context below (was
accurate through 2026-08-02, before this operator decision).

### 16.2 The apex cutover and GitHub sign-in (both live, 2026-07-30)

**1. The apex is live and canonical.** `proxywar.xyz` serves the platform;
`PROXYWAR_PLATFORM_ORIGIN` and `PROXYWAR_PUBLIC_URL` are the apex, and
`static/` was rebuilt so the client's build-time define matches. Three things
had to change together, and each is a trap on its own:

- **The zone Redirect Rule.** It matched `proxywar.xyz` AND `www.proxywar.xyz`
  and 301'd both to `beta.../league`, at the edge, before any origin. It was
  narrowed to `http.host eq "www.proxywar.xyz"` and renamed "www to league" —
  narrowed, not deleted, because deleting it would have silently dropped www
  too. There is still no API path to it (`cert.pem` holds only an `ARGO TUNNEL
  TOKEN`, `cloudflared` has no `rules` subcommand), so this is dashboard-only.
- **The apex DNS record.** It was a *proxied placeholder* `A 192.0.2.1`, which
  only ever "worked" because the redirect rule fired first. Deleting the rule
  without fixing this would have served 5xx from the apex. There IS an API path
  here, contrary to what this section used to imply:
  `cloudflared tunnel route dns --overwrite-dns open-frontier-beta proxywar.xyz`
  replaces it with a tunnel CNAME using the same `cert.pem`.
- **`cloudflared` had to reload.** The apex ingress line had been staged in
  `~/.cloudflared/open-frontier-beta.yml` for days, but the running process
  predated it, so the apex hit the config's `http_status:404` catch-all. `kill
  -HUP <pid>` reloads ingress without dropping the tunnel — no restart, no
  downtime for `beta`/`bet`/`app`.

`app.proxywar.xyz` stays in the ingress but is NOT an alias. It now 302s to the
apex (`resolveCanonicalHostRedirect`, `PlatformCanonicalHost.ts`) — GET/HEAD
only, because a redirected write is re-sent as a GET and would look like a
success that never happened, and loopback is exempt in both directions so
health checks, the league refresher and dev on `127.0.0.1:8793` are untouched.
Before that redirect existed, a visit to the stale host minted a SECOND
host-only session whose reads worked and whose every write 403'd
`origin_rejected`: worse than a hard failure, because it looks fine until you
try to set a display name. The ops config claimed this redirect existed for
days before it did; `grep resolveCanonicalHostRedirect src/` was empty.

**Still owed after the cutover: one betting redeploy (gated).** The account
origin's fallback used to be copy-pasted into four files; it is now
`DEFAULT_PLATFORM_ORIGIN` (`src/core/PlatformOrigin.ts`). The platform itself
was never affected — its launcher sets `PROXYWAR_PLATFORM_ORIGIN` explicitly —
but `bet.proxywar.xyz` sets nothing, so until it is redeployed it still serves
`connect-src 'self' https://app.proxywar.xyz` and still ships a client bundle
that fetches the same host. That is not a harmless agreement between the two:
`app.` only 302s now, CSP is re-checked against the redirect target, so the
credentialed `/api/account/pov-claims` fetch is blocked. The PoV camera default
on the market page is broken until this ships. Nothing else on betting is
affected (points, markets and guest bankrolls never touch the platform origin).

```sh
cd ~/.proxywar-deploy/bet-origin
git fetch origin && git reset --hard origin/claude/betting
env -u PROXYWAR_PLATFORM_ORIGIN npx vite build   # unset ON PURPOSE: exercises the shared fallback
# then let the autocycler restart the origin on its next cycle (~25 min) —
# autocycle-premiere.sh never rebuilds the client, only restarts the server
curl -sS -D - -o /dev/null https://bet.proxywar.xyz/league | grep -i content-security-policy
```

**Superseded 2026-08-02**: `PROXYWAR_PLATFORM_ORIGIN` IS now set on the
betting launcher (§16.1, §17.5) — the operator lifted the 2026-07-30 hold.
This also fixes the CSP/PoV gap this subsection originally described.

**2. GitHub sign-in is live (2026-07-30).** App `3760561` (client id
`Ov23likxrRLTNNoQd5Dy`) is named "Proxy War", homepage `https://proxywar.xyz`,
callback `https://proxywar.xyz/api/auth/github/callback`, device flow off, no
scopes — the public profile is all that is read. Verified end to end: the
authorize screen said "Public data only" and redirected back to
`/account?github=linked`, and the page then showed the GitHub handle with
"Verified via GitHub". `./verify-github-signin.sh` passes 11/11.

The client secret was installed BY THE OPERATOR and must stay that way. Two
independent reasons, both still true for the next rotation: GitHub interposes a
"Confirm access" password/passkey prompt on secret generation, and this repo's
own rule (`AGENTS.md`, Autonomy) forbids an agent reading or writing OAuth
secrets — it may check only that the value is present. To rotate:

```sh
# github.com/settings/applications/3760561 -> "Generate a new client secret"
printf '%s' '<secret>' > ~/.proxywar-deploy/github-oauth-client-secret
chmod 600 ~/.proxywar-deploy/github-oauth-client-secret
launchctl kickstart -k "gui/$(id -u)/com.proxywar.platform"
./verify-github-signin.sh          # defaults to the apex
```

`printf`, not `echo`: a trailing newline is trimmed by the resolver but the
verifier flags it, because the next secret-shaped file may not be so lucky. The
mode matters — `resolveGithubOAuthClientSecret` `lstat`s the file and refuses
anything group/world-readable, not-owned, or a symlink, so a 0644 secret fails
closed rather than quietly working. The secret is shown ONCE and is not
recoverable; it is also not in the copy button's `value` attribute, so it cannot
be lifted programmatically — plan for a human at that step.

With the credentials absent the OAuth routes are **absent, not broken**: in
league-wrapper mode they fall through to the wrapper's `/league` 302 (a plain
404 only without the wrapper), and the homepage's Account card and meta
description both change wording to match rather than advertising a sign-in that
does not answer. That conditional is asserted by
`tests/server/PlatformRootPage.test.ts`, and the difference is observable:
configured reads "Sign in with GitHub once…", unconfigured reads "Sign-in is not
open yet, so this browser is your identity for now."

### 16.3 Known and deliberate gaps

- **The PoV default is not on `beta.proxywar.xyz`, by decision — and it needs no
  handoff to get there.** The mechanism is built and live: the league does not
  need a session, an account link, or a redeemed code, because `beta`, `bet` and
  `app` are cross-ORIGIN but same-SITE, so a credentialed `fetch` to
  `GET {platform}/api/account/pov-claims` carries the platform's host-only
  `SameSite=Lax` cookie. Verified in Chrome via
  `Network.requestWillBeSentExtraInfo`: from `bet.proxywar.xyz`, the
  `proxywar_platform_account` cookie is attached with `blockedReasons: none`.
  The platform side is deployed and allowlist-verified live (`beta` gets the
  CORS grant; `bet` and an arbitrary origin get an empty set and no header).

  What is missing is only the CONSUMER. `beta` is served from the worktree
  `~/Documents/proxywar_worktrees/replay-premiere-release-candidate` on branch
  `codex/replay-premiere-release-candidate` — a different release line, which
  contains no PoV feature at all (`PointOfView.ts`,
  `PointOfViewSelector.ts`, `playerProfileLink.ts` are all absent) and still
  serves `connect-src 'self'`, which would block the fetch as a silent console
  violation regardless.

  Bringing it over is a RELEASE decision, not a deploy: it means putting ~60
  commits of platform/accounts/betting work onto the live league that the
  Softmax mirror and 14 real agents use. The operator was asked and chose to
  leave `beta` alone. The manual PoV picker already works there; only the
  automatic default from a claim is absent. Do not "fix" this by repointing the
  beta service at another branch.

  Note the one commit that line had and this one lacked — `137fb530f`
  (`fix(legal)`, removing OpenFront LLC's terms/privacy pages) — is now
  cherry-picked here, so a future merge in this direction regresses nothing.
  Those paths were never actually exposed on `app.`/`bet.` (league-wrapper mode
  redirects them to `/league`), but the files were still in the tree.
- **A lineage claim is self-asserted and private, and no GitHub join is exposed
  by anything we have inspected.** Measured 2026-07-30, including an
  AUTHENTICATED read of Softmax's own dashboard API: `GET
  /api/observatory/players` returns `user_id`, `user`, `id`, `name`,
  `is_default`, `avatar_url`, `created_at`, `disabled_at`, and `whoami` returns
  `user_email`, `name`, `subject_id`, `owner_user_id`, `scopes`. Neither body
  mentions GitHub anywhere. Softmax identity is an email plus internal uuids
  (`ply__…`). Our own side is equally empty: the league mirror's `standings[]`,
  the agent manifests, and the Coworld adapter carry no owner field, and
  `/api/observatory/players` is 401 anonymously.

  This was then checked for OTHER competitors, not just the signed-in user's own
  player, by driving the dashboard's own navigation (Leagues → a division) and
  reading the endpoints it actually calls —
  `/api/observatory/v2/leagues/{id}/division-ladder` and
  `/api/observatory/v2/divisions/{id}/first-place`. Divisions carry `id`, `name`,
  `level`, `member_count`; a champion record carries `player_id`, `player_name`,
  `second_player_id`, `second_player_name`, `taken_from_player_id`,
  `taken_from_player_name`, `score`, `rounds_held`. No GitHub or email field in
  any of it, no `github.com` link anywhere on the leagues view, and the public
  site's navigation exposes no competitor directory at all — its only GitHub
  link is to `Metta-AI/coworld`, the project's own repo.

  Scope, so nobody over-reads it: this covers the surfaces the dashboard itself
  uses. Some endpoint or profile view not reached here could still expose more,
  and the nested `user` object in `players` came back unexpanded. "Competitors
  are identified by `player_id`/`player_name`, and no GitHub join is available"
  is established; "Softmax stores no GitHub link anywhere" remains unproven.

  So do NOT auto-assign agents by matching a GitHub login against `playerName`,
  a policy label, or an email. Nothing constrains those namespaces to agree, and
  a match on a user-settable field is an account-takeover primitive, not a proof
  — the same unsoundness this tree already refuses for display names (next
  bullet). A wrong auto-claim publicly attributes someone else's agent.

  What Softmax DOES model is a **player credential**: "players are first-class
  competition identities… mint a credential… player credentials can upload
  policies and submit them to seasons." Ownership is therefore provable by
  demonstrated control of a player, not by any handle. Two shapes follow, and
  only the second needs nothing from Softmax:
  1. **Sanctioned sign-in** — blocked: `softmax.com/cli-auth` validates
     callbacks against a literal `127.0.0.1`/`localhost` allowlist. The ask is
     DRAFTED, with no verified send record; sending it needs an explicit
     operator request. See
     `docs/project-state/2026-07-27-softmax-signin-ask.md`.
  2. **Nonce in a submitted policy label — a HYPOTHESIS, not a design yet.** The
     platform issues a one-time code, the owner submits a policy version whose
     label carries it, and the platform reads that label back out of the league
     mirror it already syncs. Attractive because no token ever reaches us and it
     needs nothing from Softmax. Two things must be verified before it is
     trustworthy, because if either fails it proves only that SOMEONE submitted
     a policy, not that the claimant owns the agent: (a) that a policy label is
     free text chosen by the submitting player, and (b) that the mirror row
     carrying a label is the row of the player that submitted it — i.e. that the
     `playerName` ↔ `policyLabel` pairing in `standings[]` really is a
     submitter binding and not a display join. Cost even then: a real policy
     upload per verification.
- **Betting and account profiles are keyed by `platformAccountId`, never by
  display name.** Display names are not unique, so string matching would have
  collapsed two people's profiles into one arbitrary account's stats.
  `/api/players/:name` is league-identity-only and carries no betting key at all.

### 16.4 The disk trap that will bite again

The exhibition generator refuses to write below a **25 GiB** free-space reserve.
This machine sits near 17 GiB, so every fallback cycle died silently with "does
not meet the free space reserve" and betting served 503. `cycle-premiere.sh` now
passes the generator's own documented escape hatch,
`PROXYWAR_ALLOW_LOW_DISK_HEAVY_WRITE=1`, which lowers the floor to 15 GiB. That
is a ~1.5 GiB margin, not a fix. If free space drops below 15 GiB, exhibitions
stop again and no code change helps.

Two related habits worth not repeating: fallback cycles wrote a staging bundle
every cycle with nothing pruning them, so the loop slowly ate the reserve it
depends on (now pruned to the newest three after each successful admission); and
`chmod +x *.sh` flips the exec bit on files git tracks as non-executable, which
dirties the tree — and the generator refuses to run from a dirty checkout, so
the blanket chmod was itself blocking every cycle.


## 17. Betting-surface pickup: consolidation, deploy refresh, and the real-fixture readiness answer (Reconciliation session, 2026-08-02)

### 17.1 Live-state reconciliation at pickup

`~/.proxywar-deploy/bet-origin` was a detached clone at `359ba1130` (the
`claude/betting-corrections` tip) — i.e. the disclosure-copy fix from §16's
era was already deployed live but **not yet merged back** into
`claude/product-overhaul`. `git merge-base --is-ancestor
claude/betting-corrections claude/product-overhaul` was false at pickup,
confirming the gap the handoff brief (`docs/BETTING_HANDOFF.md`) predicted.
`autocycle-premiere.sh`'s own log showed **146 consecutive exhibition
fallback cycles** at pickup (up from the brief's "135+"), confirming the
real-league queue is still stuck — `~/.proxywar-deploy/premiere-queue/cost-
ledger.jsonl`'s last successful entry is still `2026-07-28T15:52:45Z`; no
entries were added between the brief being written and this session.

### 17.2 Consolidation

`git cherry-pick 359ba1130 ff0f8eda4` onto `claude/product-overhaul` — clean,
no conflicts (`87d060ee7`, `17ffd5ada`). Both wagering test suites (34 files
/ 260 tests), `tsc --noEmit`, and `npm run lint` (0 errors, 113 warnings —
the same deliberate nullish-coalescing count SEASON_ZERO_BASELINE.md
recorded) stayed green after the merge.

### 17.3 Bet-origin redeploy

Per §4's documented shape — fetch, detach to the SHA, `npm run build-prod`,
never restart mid-market:

```sh
cd ~/.proxywar-deploy/bet-origin
git fetch origin claude/product-overhaul   # NOTE: bare `git fetch origin`
                                            # left origin/claude/product-overhaul
                                            # stale in this session (an older
                                            # commit, `ce0105de7`) even though
                                            # `git ls-remote` showed the true
                                            # tip correctly — fetch the branch
                                            # BY NAME explicitly, or detach to
                                            # an explicit SHA (as below) rather
                                            # than trusting the bare refspec.
git checkout --detach 17ffd5adac969f37eb01badb50b8701b8f092655
npm run build-prod                          # tsc --noEmit + vite build, both clean
# let the autocycler's next natural restart pick it up (~25-30 min observed
# this session: 00:19:27 up -> 00:42:59 settled -> 00:46:02 up on the new build)
```

Verified live post-cycle: served `assets/main-BxFB02td.js` matches the new
build byte-for-byte (same hash as a from-scratch build of the identical
source); `grep` of the deployed bundle confirms the disclosure strings
("House exhibition — not a league round", "Play money only", "simulated
house crowd trades") are present; `/api/premieres/points/leaderboard`
returned an **identical** snapshot before and after the ridden cycle
(`lifetimePoints`/`premieresTraded`/`updatedAt` all unchanged) — real proof
the points ledger survives `cycle-premiere.sh`'s state-root wipe exactly as
`ReplayPremierePointsLedger.ts`'s module doc claims; and the synthetic crowd
resumed trading on the fresh premiere (`q` non-zero, prices diverged from
25/25/25/25) within ~2 minutes of the new premiere coming up.

### 17.4 The real-fixture readiness question — a live-verified NO, not a gap

The candidate reuse (admit the already-generated **Aug-3 Season Zero
Featured Event**, `feat_4d20f6550c6c8d8e83bc` / episode
`ereq_253e5a33-...`, as a bet premiere with zero new billing) **does not
exist as a legitimate path, by deliberate design** — this was proven live,
not just read from code:

`feature:promote`/`premiere:package`'s own candidates come from
`CoworldLeagueEpisodeRow[]`, populated by `coworld-league-mirror.ts`
downloading **hosted, public** Coworld replays into
`artifacts/ai-league-runs/league-coworld-<id>/` (`feature-candidates.ts`'s
own module doc). `PremiereWageringProvenance.ts`'s
`classifyPremiereWageringProvenance` refuses to seal ANY bundle whose
directory matches that `league-coworld-*` pattern — **not overridable by a
`--source` declaration** (`seal-episode.ts`'s own `--help`: "this
classification cannot be overridden by declaration — the pattern is the
ground truth the mirror/demo-server themselves use") — because Softmax's
Observatory already publishes the round's outcome the instant it completes,
independent of anything this repo does; there is no embargo left to protect.
Live dry-run proof this session (scratch bundle dir literally named
`league-coworld-feat4d20-dryrun-proof`, scratch `--private-state-root`,
never the live queue root):

```
$ npx tsx src/scripts/premiere-wagering/seal-episode.ts \
    --bundle-dir=.../league-coworld-feat4d20-dryrun-proof \
    --private-state-root=<scratch> --skip-already-premiered-check
PREMIERE_WAGERING_SEAL_REFUSED [PremiereWageringSealingError] refusing to
mark league-coworld-feat4d20-dryrun-proof sealed: bundle directory name
matches the public-league mirror's managed run key pattern
(league-coworld-*); Observatory already publishes this round's outcome
independently of anything this repo does, and the mirror's own static-file
route serves it by path regardless of any suppression hold
```

`--source=xp-request` declared explicitly still refuses (pattern wins over
declaration, confirmed live). `--force-unsafe-seal` DOES seal it, but the
manifest still honestly records `"source": "public_league_mirror"` — it
never launders the provenance, exactly as documented; this flag is a
dev/test escape hatch, not an admission path, and using it in production
would violate the Honest UI hard rule (embargo copy over a match that was
never actually embargoed). **Do not build a bypass for this** — it is a
deliberate safety refusal, not a missing feature.

**What DOES work, verified live end-to-end this session at zero cost:**
`replay-premiere-controlled-exhibition.ts` (§4, free/local/deterministic,
no Coworld dependency) → admit (§6, wagering + crowd env from §13.5) →
restart → real synthetic-crowd trading with zero human input (`q` non-zero,
prices diverged from 25/25/25/25 within ~60s of `scheduledAt`) — the exact
free/synthetic proof of the wagering pipeline the task asked for. One
environment note for whoever repeats this in a **fresh, isolated clone**
(not the shared dev checkout): the leak-audit collector (`replay-premiere-
admit.ts`) fetches `/league` and `/ai-league-runs/league/data.json` from
the deployment origin as part of its safety check, and refuses admission
(`premiere_leak_collected_leak_audit_failed`) if those routes 404 — a
hollow scratch checkout has no league-mirror output on disk. Point
`PROXYWAR_ARTIFACTS_ROOT` at any real, already-generated league-mirror
artifacts directory (e.g. the canonical checkout's `artifacts/`) to satisfy
it; this is a real safety check (confirms the served roots don't leak the
spoiler-sensitive episode), not a bug, and costs nothing to satisfy since
it only reads pre-existing artifacts.

**The actual "fund it" lever** is unrelated to the Featured Event: resume
the already-built, already-throttled real-episode generator, currently
registered but not bootstrapped:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.proxywar.betqueue.plist
```

This runs `generate-premiere-queue.sh` from whatever is checked out in
`~/.proxywar-deploy/bet-origin` (now the consolidated `17ffd5ada` tip),
self-throttled to `PW_QUEUE_MAX_PER_HOUR=4` / `PW_QUEUE_MAX_PER_DAY=80`,
issuing real, **billed** `xp-request` episodes (private — 404 to any
non-requester per `softmax-platform-feedback.md` item 26, hence genuinely
embargo-safe unlike the league-mirror path above) against the live 14-16
agent roster. Cost expectation, sourced from repo evidence, not invented:
the cost ledger itself only records `wallClockSeconds`/`turnCount` (its own
comment: "the platform does not surface cost_usd through this API surface
today" — cross-reference Softmax billing separately to true up), but
`softmax-platform-feedback.md`'s directly-measured `cost_usd` for a
comparable hosted episode was **$0.09 (20-step 12p) / $0.19 (completed full
12p) / $0.10-0.21 (a failed attempt)** — our 14-16p roster will run
somewhat higher per the seat-count difference but is the same order of
magnitude ("trivial and platform-tracked" in the operator's own words).
Historical throughput from the 52-attempt ledger: 47/52 (90%) succeeded,
avg wall-clock ~1047s (~17.5 min), avg turnCount ~24,970. Once the queue has
one ready item, `cycle-premiere.sh` picks it up automatically on its next
cycle — no separate admission step, and no further action beyond the one
`launchctl bootstrap` command.

### 17.5 Both operator gates lifted and verified live (Activation session, 2026-08-02)

Two explicit operator decisions, quoted and dated: **"use xprequests for
betting matches"** — real billed xp-request episode generation authorized
for the betting premiere queue; **"implement identity handoff for
betting"** — the platform→bet handoff (§15-16, off since 2026-07-30) is to
be enabled and verified. Both superseded prior holds in §16.1/§16.2/§17.4.

**Real episodes**: `launchctl bootstrap` failed with `Bootstrap failed: 5:
Input/output error` from this session's shell context (no GUI-session
bootstrap capability) — `launchctl load -w
~/Library/LaunchAgents/com.proxywar.betqueue.plist` worked instead (older
API, same effect, service came up running). First real generation
succeeded in 596s/21,500 turns (cost ledger `2026-08-02T03:01:56Z`,
`episodeId ereq_2fb85305-...`); the next natural cycle admitted it as
`prem_ba2ae0a0c2626d524d41`, autocycle logged `match kind: real-league`
(first non-fallback cycle since 2026-07-28), fallback streak reset, and the
queue immediately started generating episode #2 (caps holding: 1/4 hour,
1/80 day). Live-verified: manifest `provenance.coworld.episodeId` matches
the ledger entry exactly; seats carry real `policyIdentity.namespace:
"softmax_policy_version"` agents (softmaxwell, daveey, docxology, etc.);
the page renders "Proxy War Live Market - Real AI League Premiere" / "LIVE"
— the exhibition label is gone; synthetic crowd moved prices off the
uniform baseline within the first poll.

**Identity handoff**: enabled via one line in `cycle-premiere.sh`'s
`start_origin()` (not the untracked launcher script — that env var is set
once at process start and would need a betautocycle restart to take
effect; `cycle-premiere.sh` itself is re-read fresh from disk every cycle,
so a plain redeploy + natural cycle was enough), defaulting to
`https://proxywar.xyz` (matches the platform's own
`PROXYWAR_PLATFORM_RETURN_ORIGINS`, already configured). Security audit
against live code, no gaps found: `PlatformHandoffStore` — 2min code TTL,
64-hex-char random code, atomic one-time redeem (synchronous check-then-
delete), bound to state+returnOrigin+audience+childSessionId;
`PlatformReturnOrigins` — explicit non-reflecting allowlist, malformed
entries dropped per-entry not fail-closed-whole-map; cookies — HttpOnly,
SameSite=Lax, Secure (in production, derived from `publicOrigin.startsWith
("https://")`, not GAME_ENV so this holds despite `GAME_ENV=dev` on the
hosted deploy), no `Domain=` (host-only). Verified live end-to-end via
curl with a real guest cookie (no real GitHub credential needed — both
ends bootstrap anonymous-first): `/handoff/start` → 302 to platform with
state/audience/childSessionId → platform mints an account + code → 302
back to `/handoff/callback` → redeemed → `platformLinked: true`; replaying
the same code afterward correctly 302s to `?identity=error` (one-time
enforced). As a direct, honest side effect: `bet.proxywar.xyz/account`'s
raw "account management is not available on this deployment" 503 (P1,
live-QA) is gone — `configuredPlatformOrigin` being defined now makes that
route's existing branch 302 to the platform's own `/account`; no code
change needed for this, verified live.

**A real, live-reproduced P0 found during verification, unrelated to
either gate but blocking honest use of both**: guest bankroll/positions
silently wiped on reload. Root cause, confirmed via CDP against a real
cold `/bet/<id>` load: `PremiereGithubSignIn`'s `GET /api/identity/status`
and `ReplayPremiereRuntimeController`'s `POST .../sessions` fire
concurrently with no coordination; each independently sees "no guest
cookie yet" and mints its own distinct identity via `Set-Cookie`
(`bootstrap()` itself correctly reuses an existing cookie — the gap was
purely a missing client-side ordering guarantee). One cold load minted
BOTH `guest_14fe29a1...` and `guest_1dd20142...`; the browser keeps
whichever `Set-Cookie` lands last, silently orphaning the other identity's
trades. Fixed: `src/client/identity/GuestBootstrapGate.ts`, a page-scoped
gate serializing every identity-touching fetch behind the first to start,
wired into `GithubSignIn.ts`, `ReplayPremiereRuntime.ts`'s session
creation, `AccountPage.ts`, `PointsLeaderboard.ts`. A visible symptom of
the same race — a raw `request_rejected` error-code flash on cold boot,
self-healing within seconds — got its own bounded-retry fix in
`BettingPremierePage.ts`'s `pollOnce` (extends the pre-existing
`session_required` startup-race allowance to a 401/403 `request_rejected`
too, capped at `STARTUP_AUTH_RETRY_LIMIT=5` so a genuinely broken identity
still surfaces a real error). Commit `50747bb73`; 353/353 tests green,
`tsc`/`eslint` clean; deployed to bet-origin, pending the next natural
cycle to go live (never forced mid-market).

**What was NOT reached this session, genuinely out of budget, not worked
around**: the market's own full reload/second-tab persistence proof on the
REAL premiere (trade → reload → position intact) post-deploy, and a
signed-in (post-handoff) identity's positions surviving a reload — the
P0 fix's client-side unit tests (gate serialization, startup-auth retry
bound) are green and the mechanism is directly reproduced/fixed at its
root, but the live end-to-end click-through on the newly-deployed build
was not completed before this session's budget ran out. Whoever picks
this up next: the deploy is already live (or about to go live on the next
natural cycle) — just click through it.