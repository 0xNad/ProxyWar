# Proxy War Replay Premiere + Live Betting — local runbook

Status as of this session: **a controlled-exhibition premiere can be built, admitted, and
served with a live LMSR market (`GET /premiere/<id>` and `GET /bet/<id>` both return 200,
`GET /api/premieres/<id>/market` returns a real open market with moving-eligible prices).
The dedicated betting page in a real browser still hangs on "Joining live…" due to one
unrelated, unfixed client bug** — see "Known remaining blocker" at the end. Everything
above that line is real, reproduced, command-verified output from this session, not
aspirational instructions.

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

## Known remaining blocker: the betting page hangs on "Joining live…" in a real browser

Verified via `PROXYWAR_LEAGUE_WRAPPER_ONLY=true` + `ai-agent-demo-server.ts` (this
session's whole setup) with a live, open market (`GET .../market` returned
`"status":"open"`, prices `[25,25,25,25]`) and a fresh `/bet/<id>` (HTTP 200):

Opening the page in a real browser (headless Chromium via CDP) shows a spinner and
"Joining live…" indefinitely. Captured browser console:

```
error: WebSocket connection to 'ws://127.0.0.1:8787/w1/lobbies' failed:
  Error during WebSocket handshake: Unexpected response code: 302
error: Failed to load resource: the server responded with a status of 400 (Bad Request)
REQFAIL: http://127.0.0.1:8787/api/premieres/<id>/chunks/0 net::ERR_ABORTED
```

(Plus benign CSP-blocked third-party script/analytics noise — `crazygames-sdk`,
`turnstile`, `googletagmanager`, `cloudflareinsights` — unrelated to this flow.)

`grep`-confirmed: neither `ReplayPremiereRuntime.ts` nor any file under
`src/client/prediction/wagering/**` opens a WebSocket at all. `Main.ts`'s route dispatch
(`parseBettingPremiereRoute` → `openBettingPremiere`, `Main.ts:709-714`) correctly early-
returns *before* the ordinary multiplayer lobby-join path (`joinLobby` from
`ClientGameRunner.ts`, `Main.ts:1618`) — so on paper this websocket attempt should be
unreachable for a `/bet/<id>` page load, yet it fires. Something in the client boot chain
(a module-level side effect, a shared ambient connection, or a code path this session
didn't locate before running out of budget) still tries to join the real-time multiplayer
lobby regardless of route. `ai-agent-demo-server.ts` doesn't run the `/w1/*` worker
websocket infrastructure at all (that's `src/server/Server.ts`'s job, the "master/worker"
game server used by `npm run dev` — which in turn has **zero** ReplayPremiere/wagering
wiring, confirmed by `grep -i premiere src/server/Server.ts` returning nothing), so this
websocket handshake can never succeed against the server topology this whole wagering
build currently runs on.

**Smallest fix**: find and gate whatever establishes the `/w1/lobbies` connection so it's
skipped whenever `parseBettingPremiereRoute`/`parseReplayPremiereRoute` matches (mirroring
the early-return already correctly in place at `Main.ts:699-714` for the surrounding
route dispatch) — or, if it's structural (e.g. `ClientGameRunner` module-level
initialization independent of the route check), move premiere/betting route detection
earlier than that initialization. This was not fixed in this session; it is the one
concrete step between "server-side stack fully works" (verified above) and "full watch →
buy → price-move → sell → hold → settle → bankroll loop screenshot-verified in a browser"
(not completed — ran out of session budget immediately after diagnosing this).

## What was and wasn't verified in this session

**Verified (real commands, real output, captured above):**
- Root-caused three independent server-side bugs blocking every controlled-exhibition
  admission on this branch unconditionally, and fixed all three (commits on `claude/betting`).
- Root-caused the multi-agent private-state-root lock collision (a second, completely
  separate cause of "Replay unavailable" for every id).
- Added the missing `/bet/:id` server route recognition (was silently redirecting to
  `/league`) and a wagering-compatible `--max-presentation-span-ms` admit flag.
- Produced a real controlled-exhibition source bundle from `docs/ai-league-agent-manifests`
  (deterministic, in-process, no network) and admitted it with wagering on.
- `GET /premiere/<id>`, `GET /bet/<id>`, `GET /api/premieres/<id>/bootstrap`, and
  `GET /api/premieres/<id>/market` all return correct 200 JSON/HTML against the live
  server, `market.status` transitions `open` → (later) `settled` on schedule.
- `npx tsc --noEmit` clean after every change in this session.
- One earlier admitted instance rendered the betting page's sidebar (title, map, bankroll)
  correctly in a real headless-Chromium screenshot with the SPA shell mounted — before it
  aged into `failed` state from elapsed time between admission and screenshot.

**Not verified — genuinely blocked, not worked around:**
- The full watch → buy → price-move → sell → hold-to-settlement → bankroll-reconciliation
  loop in a browser (blocked by the `/w1/lobbies` hang above).
- MarketSim / synthetic crowd order flow (not landed as a runnable local tool yet).
- Narrow-viewport check (blocked by the same hang before reaching that step).
