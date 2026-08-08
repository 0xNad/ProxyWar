#!/usr/bin/env bash
# Generates the Stage 8 deterministic public-product fixture set and boots
# the full public product against it — ONE command, zero live Softmax API
# dependency. Adapts the proven local-exhibition-admission sequence
# the public league deployment uses (start origin -> admit -> restart origin),
# simplified for deterministic local fixtures.
#
#   FIXTURE_ROOT=/Volumes/ProxyWar\ Workspace/ProxyWar/fixtures-root \
#     ./scripts/fixtures/run-public-product-fixtures.sh
#
# FIXTURE_ROOT MUST be on external storage (never the internal disk) —
# working-agreements.md's storage floor applies to internal disk only, and
# this repo's own internal disk sits well under it for the lifetime of
# this overhaul.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$HERE"

FIXTURE_ROOT="${FIXTURE_ROOT:?set FIXTURE_ROOT to an external-volume directory}"
PORT="${FIXTURE_PORT:-8787}"
ORIGIN="http://127.0.0.1:${PORT}"
# Port-scoped, NOT a shared fixed path — this script is run by multiple
# concurrent sessions in the same worktree (each with its own FIXTURE_PORT
# and FIXTURE_ROOT). A fixed `/tmp/pw-fixture-origin.pid` meant one
# session's `stop_origin`/restart could `kill` a DIFFERENT session's
# already-running origin process the moment two sessions' scripts
# overlapped, because the last writer to the shared pidfile silently won.
# Keying both paths on $PORT keeps each session's start/stop cycle scoped
# to the process it actually owns.
PIDFILE="/tmp/pw-fixture-origin-${PORT}.pid"
LOGFILE="/tmp/pw-fixture-origin-${PORT}.log"

IDENTITY_DIR="$FIXTURE_ROOT/identity"
ARTIFACTS_ROOT="$FIXTURE_ROOT/artifacts"
PREMIERE_STATE_ROOT="$FIXTURE_ROOT/premiere-state"
NATIONS_DIR="$FIXTURE_ROOT/nations"
FEATURED_MATCH_STATE_ROOT="$FIXTURE_ROOT/featured-match-state"
PLATFORM_STATE_ROOT="$FIXTURE_ROOT/platform-state"
# Isolates the real tracked `resources/season/seasons.json` the same way
# every sibling root above already isolates its own subsystem — see
# `tests/e2e/support/FixtureServer.ts`'s doc comment for the bug this
# fixes (a fixture server otherwise leaks the real, committed, currently-
# featured production match onto /watch with none of its artifacts
# present in this isolated fixture root).
SEASON_REGISTRY_DIR="$FIXTURE_ROOT/season"
ADMIT_STAGING="$FIXTURE_ROOT/admit-staging"

export AI_LEAGUE_DEMO_PORT="$PORT"
export PROXYWAR_LEAGUE_WRAPPER_ONLY=true
export PROXYWAR_ARTIFACTS_ROOT="$ARTIFACTS_ROOT"
export PROXYWAR_IDENTITY_REGISTRY_DIR="$IDENTITY_DIR"
export PROXYWAR_NATIONS_DIR="$NATIONS_DIR"
export PROXYWAR_FEATURED_MATCH_STATE_ROOT="$FEATURED_MATCH_STATE_ROOT"
export PROXYWAR_REPLAY_PREMIERE_STATE_ROOT="$PREMIERE_STATE_ROOT"
export PROXYWAR_PLATFORM_STATE_ROOT="$PLATFORM_STATE_ROOT"
export PROXYWAR_SEASON_REGISTRY_DIR="$SEASON_REGISTRY_DIR"
export GAME_ENV=dev

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

stop_origin() {
    if [ -f "$PIDFILE" ]; then
        local pid
        pid="$(cat "$PIDFILE" 2> /dev/null || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
            kill -TERM "-$pid" 2> /dev/null || kill -TERM "$pid" 2> /dev/null || true
            for _ in $(seq 1 20); do
                kill -0 "$pid" 2> /dev/null || break
                sleep 0.5
            done
            kill -KILL "-$pid" 2> /dev/null || true
        fi
        rm -f "$PIDFILE"
    fi
}

start_origin() {
    # setsid isn't available on macOS; `set -m` makes bash job control create
    # a fresh process group per background job instead, which `kill -TERM
    # "-$pid"` in stop_origin can still target the same way.
    (
        set -m
        npx tsx src/scripts/ai-agent-demo-server.ts \
            > "$LOGFILE" 2>&1 < /dev/null &
        echo $! > "$PIDFILE"
    )
}

wait_for_origin() {
    for _ in $(seq 1 60); do
        if curl -s -o /dev/null -m 3 "${ORIGIN}/league"; then return 0; fi
        sleep 1
    done
    echo "origin never came up; see $LOGFILE" >&2
    return 1
}

# AI League Full Replay boot inside a real browser requires a PRODUCTION-mode
# build (`npm run build-prod`, i.e. plain `vite build`), never `build-dev`/
# `--mode development`. Root cause: `vite.config.ts` only registers the
# `syncHashedPublicAssets` plugin (the one that writes
# `static/asset-manifest.json` with hashed entries for every `resources/`
# file, including every `maps/<name>/manifest.json`) when `isProduction` is
# true — a deliberate dev-build-speed tradeoff, not a bug to route around
# here. Without that manifest, `AssetUrls.ts`'s `buildAssetUrl()` falls back
# to a bare root-relative path (e.g. `/maps/asia/manifest.json`) and never
# applies the CDN/origin base even when one is configured. That's invisible
# almost everywhere (root-relative paths resolve fine against a real page
# URL) EXCEPT inside the game engine's `?worker&inline` blob-URL Web Worker:
# `blob:` is not a "special" URL scheme per the WHATWG URL spec, so a
# root-relative reference fails to resolve against it at all, throwing
# `TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope': Failed to
# parse URL from /maps/<map>/manifest.json` and permanently stalling the
# replay at "Loading replay…" / "Replay is taking longer than expected…".
# This is a genuine `src/core/AssetUrls.ts` product-code gap (reported
# separately, not fixed here — `src/core/**` changes need review per
# AGENTS.md) that a production-mode build's populated manifest happens to
# route around. Fail fast with an actionable message instead of a silent
# multi-minute stall discovered only once a browser is pointed at this.
assert_production_build_for_full_replay() {
    local manifest_path="$HERE/static/asset-manifest.json"
    if [ ! -f "$manifest_path" ] || ! grep -q '"maps/' "$manifest_path" 2> /dev/null; then
        cat >&2 << 'EOF'
Full Replay build-manifest gate: static/asset-manifest.json is missing (or
has no maps/ entries) -- Full Replay pages will boot to a permanent
"Loading replay..." stall inside the game engine's Web Worker (root cause:
dev-mode builds intentionally skip asset-manifest generation, and
AssetUrls.ts's buildAssetUrl() fallback path does not apply the CDN/origin
base for un-manifested assets -- fails to resolve at all from inside a
blob: URL worker).
commit or run `npm run build-prod` (NOT build-dev) before this script boots
the origin, or set PROXYWAR_FIXTURE_SKIP_BUILD_MANIFEST_GATE=1 if you only
need the identity/league-mirror/analytics surfaces this script also
generates, not a real Full Replay browser boot.
EOF
        return 1
    fi
}
if [ "${PROXYWAR_FIXTURE_SKIP_BUILD_MANIFEST_GATE:-0}" != "1" ]; then
    assert_production_build_for_full_replay
fi

log "==> generating drama match (real local simulation, no Softmax)"
# league- prefixed: isProxyWarPublicLeaguePath's allowlist (the
# leagueWrapperOnly public-artifact gate in ai-agent-demo-server.ts, the
# mode this fixture server and production both run in) only lets
# /ai-league-replay/<key> and /ai-league-runs/<key>/... through for
# league-*-prefixed keys — the same prefix coworld-league-mirror.ts's
# real `publicRunKey = \`league-${replay.runID}\`` always applies.
# Without it the "Watch replay" link on /watch 404s with "AI league
# replay record not found." before the full replay overlay ever loads
# (confirmed live).
DRAMA_RUN_ID="league-fixture-drama-001"
rm -rf "$HERE/artifacts/ai-league-runs/$DRAMA_RUN_ID"
npx tsx src/scripts/ai-agent-league-smoke.ts \
    --brain=rule --runner=step-locked --scenario=actions \
    --max-steps=35 --turns-per-decision-step=140 --replay-tail-turns=7000 \
    --bots=10 --run-id="$DRAMA_RUN_ID" > /tmp/pw-fixture-drama.log 2>&1
mkdir -p "$ARTIFACTS_ROOT/ai-league-runs"
rm -rf "$ARTIFACTS_ROOT/ai-league-runs/$DRAMA_RUN_ID"
mv "$HERE/artifacts/ai-league-runs/$DRAMA_RUN_ID" "$ARTIFACTS_ROOT/ai-league-runs/$DRAMA_RUN_ID"
npx tsx src/scripts/proxywar-fixture-episode-from-run.ts \
    --run-dir="$ARTIFACTS_ROOT/ai-league-runs/$DRAMA_RUN_ID" \
    --run-id="$DRAMA_RUN_ID" \
    --out="$FIXTURE_ROOT/drama-episode.json"

log "==> writing identity registry + league mirror (upcoming premiere card only, for now)"
UPCOMING_ISO="$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")"
cat > "$FIXTURE_ROOT/premiere-upcoming.json" << EOF
{
  "premiereId": "prem_fixture0upcoming01",
  "roundNumber": 503,
  "mapLabel": "World",
  "scheduledAt": "$UPCOMING_ISO",
  "premierePageLive": false
}
EOF
npx tsx src/scripts/proxywar-fixture-league-data.ts \
    --root="$FIXTURE_ROOT" \
    --drama-episode-file="$FIXTURE_ROOT/drama-episode.json" \
    --premiere-upcoming-file="$FIXTURE_ROOT/premiere-upcoming.json"

# Live-premiere admission (active/late-join-sync/reveal-after-end E2E
# coverage) is opt-in behind FIXTURE_ADMIT_LIVE_PREMIERE=1, default OFF.
#
# Reliable AND deterministic (verified by two independent runs producing
# byte-identical turnCount/winner): a 4-seat, all-profiles exhibition never
# converged to a winner even at 300 decision steps / 60,000 turns (two
# agents were still fighting past turn 56,800 when investigated) — the
# rule brain's attack action always spends a fixed 10% of current troops
# per decision (`RuleAgentBrain.ts`'s `legalActions.find(a => a.kind ===
# "attack")` just takes the FIRST attack option, never the highest
# `troopPercent` one), so elimination is geometric attrition, not a fast
# knockout — with 4 roughly-matched agents splitting damage, no one side
# accumulates a decisive advantage in bounded turns. `alliance_extend`
# stalls (the original hypothesis) turned out NOT to be the real
# bottleneck: disabling `alliance_request`/`alliance_extend` alone did not
# fix 4-seat convergence either.
#
# What DOES converge reliably: 2 seats, both `aggressive` profile (so
# nothing dilutes into building/diplomacy over attacking), with alliance
# actions disabled so the objective manager never detours through them.
# Two 1v1 agents mean the 10%-per-decision attrition on the loser compounds
# every step with no third party to split it — verified deterministic:
# reaches a winner at turn 21,400 in ~24s wall-clock, identical outcome on
# a repeat run. `--max-steps=200` leaves ~2x headroom over the observed
# convergence point.
if [ "${FIXTURE_ADMIT_LIVE_PREMIERE:-0}" = "1" ]; then

    log "==> starting origin (needed for the premiere admission leak audit)"
    stop_origin
    rm -rf "$PREMIERE_STATE_ROOT"
    mkdir -p "$PREMIERE_STATE_ROOT"
    chmod 700 "$PREMIERE_STATE_ROOT"
    start_origin
    wait_for_origin

    log "==> generating live premiere match (2-seat aggressive-vs-aggressive, alliance actions disabled — the reliably-converging configuration)"
    mkdir -p "$FIXTURE_ROOT/admit-manifests" "$ADMIT_STAGING"
    rm -f "$FIXTURE_ROOT/admit-manifests"/*.json
    for name in aggressive aggressive2; do
        cat > "$FIXTURE_ROOT/admit-manifests/$name.json" << EOF
{
  "schemaVersion": 1,
  "agentName": "Fixture $name",
  "profile": "aggressive",
  "brainType": "rule",
  "provider": { "provider": "rule" },
  "policyIdentity": {
    "namespace": "local_manifest",
    "manifestName": "fixture-$name",
    "declaredVersion": "1"
  }
}
EOF
    done
    rm -rf "$HERE/artifacts/ai-league-runs/fixture-premiere-live"
    npx tsx src/scripts/replay-premiere-controlled-exhibition.ts \
        --run-id=fixture-premiere-live \
        --private-output-root="$ADMIT_STAGING" \
        --agent-manifest-dir="$FIXTURE_ROOT/admit-manifests" \
        --served-root="$HERE" \
        --served-root="$HERE/static" \
        --served-root="$ARTIFACTS_ROOT" \
        --brain=rule \
        --max-steps=200 \
        --turns-per-decision-step=200 \
        --replay-tail-turns=2000 \
        --disable-action-kinds=alliance_request,alliance_extend \
        --playback-turn-interval-ms=1 > /tmp/pw-fixture-premiere.log 2>&1
    # 1ms/turn (not the production-realistic 100ms/PREMIERE_REAL_TURN_INTERVAL_MS)
    # is deliberate: 21,400 turns at 1ms plays out live in ~21s, so the E2E
    # suite's "reveal after end" coverage can poll to a real reveal inside one
    # bounded test timeout instead of waiting ~36 minutes at real-time pacing.
    # Playback speed is presentation-only metadata (`replay.turnIntervalMs`);
    # it does not affect the deterministic turnCount/winner above.
    BUNDLE="$ADMIT_STAGING/fixture-premiere-live.source.json"
    SHA="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"

    mkdir -p "$ADMIT_STAGING"
    if [ ! -f "$ADMIT_STAGING/nonce.bin" ]; then
        python3 -c "import os;open('$ADMIT_STAGING/nonce.bin','wb').write(os.urandom(32))"
        chmod 600 "$ADMIT_STAGING/nonce.bin"
    fi
    python3 - "$BUNDLE" "$ADMIT_STAGING" << 'PY'
import json, os, sys, datetime
bundle, admit_in = sys.argv[1], sys.argv[2]
d = json.load(open(bundle))
tc = d["replay"]["turnCount"]
now = datetime.datetime.now(datetime.timezone.utc)
iso = lambda x: x.strftime("%Y-%m-%dT%H:%M:%S.000Z")
json.dump({
    "schemaVersion": 1, "eligibilityCheckVersion": "local-dev/v1",
    "externalEmbargoEvidence": [{
        "source": "controlled runner", "scope": "source and outcome",
        "observedAt": iso(now), "verifier": "operator", "embargoConfirmed": True}],
    "externalOutcomeMayBePublic": False, "publicLabel": "premiere",
}, open(os.path.join(admit_in, "eligibility.json"), "w"), indent=2)
json.dump({
    "schemaVersion": 1,
    "title": "Fixture Live Premiere",
    "spoilerNeutralDescription": "A short, deterministic fixture match for Stage 8 E2E coverage.",
    "map": {"id": "Asia", "label": "Asia"},
    "matchFormat": {"id": "ffa-2", "label": "2-seat FFA", "seatCount": 2},
    "scheduledAt": iso(now),
    "playbackRate": 1,
    # Checkpoints must land while BOTH seats are still alive (admission
    # requires >=2 alive options at each checkpoint sequence — see
    # ReplayPremiereCheckpointProjection.ts's checkpoint_projection_fewer_
    # than_two_options). The production 35%/65% split (ReplayPremiereLoop
    # Core.ts's checkpointSequencesForTurnCount) assumes a real league
    # match's slower pace; this fixture's fast 2-seat elimination match
    # resolves well before that — verified empirically against this exact
    # deterministic bundle that 35%/65% (turns 7489/13910) fails admission
    # (the loser is already eliminated by then) while 10%/20% succeeds.
    "checkpoints": [
        {"id": "cp_00000001", "sequence": int(tc * 0.10)},
        {"id": "cp_00000002", "sequence": int(tc * 0.20)},
    ],
}, open(os.path.join(admit_in, "definition.json"), "w"), indent=2)
print(f"    turns={tc} duration={tc*d['replay']['turnIntervalMs']/1000:.1f}s")
PY

    log "==> admitting fixture-premiere-live"
    PROXYWAR_PUBLIC_URL="$ORIGIN" npx tsx src/scripts/replay-premiere-admit.ts \
        --premiere-id="prem_fixture0premiere01" \
        --source-file="$BUNDLE" \
        --expected-source-sha256="$SHA" \
        --private-state-root="$PREMIERE_STATE_ROOT" \
        --served-root="$HERE" --served-root="$HERE/static" --served-root="$ARTIFACTS_ROOT" \
        --eligibility-file="$ADMIT_STAGING/eligibility.json" \
        --definition-file="$ADMIT_STAGING/definition.json" \
        --deployment-origin="$ORIGIN" \
        --nonce-file="$ADMIT_STAGING/nonce.bin"

    log "==> regenerating league mirror with the now-live premiere (data.json/read-model.json were written before admission and don't know about it yet)"
    cat > "$FIXTURE_ROOT/premiere-live.json" << EOF
{
  "premiereId": "prem_fixture0premiere01",
  "roundNumber": null,
  "mapLabel": "Asia",
  "scheduledAt": "$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")",
  "premierePageLive": true
}
EOF
    npx tsx src/scripts/proxywar-fixture-league-data.ts \
        --root="$FIXTURE_ROOT" \
        --drama-episode-file="$FIXTURE_ROOT/drama-episode.json" \
        --premiere-upcoming-file="$FIXTURE_ROOT/premiere-live.json"

    log "==> restarting origin onto the admitted premiere (admission never hot-registers)"
    stop_origin
    start_origin
    wait_for_origin
    PREMIERE_STATUS="admitted: prem_fixture0premiere01"

else

    log "==> starting origin (FIXTURE_ADMIT_LIVE_PREMIERE not set — skipping live-premiere admission)"
    stop_origin
    rm -rf "$PREMIERE_STATE_ROOT"
    mkdir -p "$PREMIERE_STATE_ROOT"
    chmod 700 "$PREMIERE_STATE_ROOT"
    start_origin
    wait_for_origin
    PREMIERE_STATUS="skipped (set FIXTURE_ADMIT_LIVE_PREMIERE=1 to attempt it)"

fi

URL="${ORIGIN}"
echo
echo "    fixture public product live at ${URL}"
echo "    live premiere: ${PREMIERE_STATUS}"
echo "    pid $(cat "$PIDFILE" 2> /dev/null || echo unknown), log $LOGFILE"
echo "    stop with: kill \$(cat $PIDFILE)"
