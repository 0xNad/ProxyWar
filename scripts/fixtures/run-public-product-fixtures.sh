#!/usr/bin/env bash
# Generates the Stage 8 deterministic public-product fixture set and boots
# the full public product against it — ONE command, zero live Softmax API
# dependency. Adapts the proven local-exhibition-admission sequence
# `cycle-premiere.sh` already uses in production for bet.proxywar.xyz's
# demo (start origin -> admit -> restart origin), simplified for the
# public LEAGUE origin: no betting/points/GitHub-OAuth concerns here.
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
PIDFILE="/tmp/pw-fixture-origin.pid"
LOGFILE="/tmp/pw-fixture-origin.log"

IDENTITY_DIR="$FIXTURE_ROOT/identity"
ARTIFACTS_ROOT="$FIXTURE_ROOT/artifacts"
PREMIERE_STATE_ROOT="$FIXTURE_ROOT/premiere-state"
NATIONS_DIR="$FIXTURE_ROOT/nations"
FEATURED_MATCH_STATE_ROOT="$FIXTURE_ROOT/featured-match-state"
PLATFORM_STATE_ROOT="$FIXTURE_ROOT/platform-state"
ADMIT_STAGING="$FIXTURE_ROOT/admit-staging"

export PROXYWAR_LEAGUE_WRAPPER_ONLY=true
export PROXYWAR_ARTIFACTS_ROOT="$ARTIFACTS_ROOT"
export PROXYWAR_IDENTITY_REGISTRY_DIR="$IDENTITY_DIR"
export PROXYWAR_NATIONS_DIR="$NATIONS_DIR"
export PROXYWAR_FEATURED_MATCH_STATE_ROOT="$FEATURED_MATCH_STATE_ROOT"
export PROXYWAR_REPLAY_PREMIERE_STATE_ROOT="$PREMIERE_STATE_ROOT"
export PROXYWAR_PLATFORM_STATE_ROOT="$PLATFORM_STATE_ROOT"
export GAME_ENV=dev

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

stop_origin() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -KILL "-$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
}

start_origin() {
  # setsid isn't available on macOS; `set -m` makes bash job control create
  # a fresh process group per background job instead, which `kill -TERM
  # "-$pid"` in stop_origin can still target the same way.
  ( set -m; npx tsx src/scripts/ai-agent-demo-server.ts \
      > "$LOGFILE" 2>&1 < /dev/null & echo $! > "$PIDFILE" )
}

wait_for_origin() {
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null -m 3 "${ORIGIN}/league"; then return 0; fi
    sleep 1
  done
  echo "origin never came up; see $LOGFILE" >&2
  return 1
}

log "==> generating drama match (real local simulation, no Softmax)"
rm -rf "$HERE/artifacts/ai-league-runs/fixture-drama-001"
npx tsx src/scripts/ai-agent-league-smoke.ts \
  --brain=rule --runner=step-locked --scenario=actions \
  --max-steps=35 --turns-per-decision-step=140 --replay-tail-turns=7000 \
  --bots=10 --run-id=fixture-drama-001 > /tmp/pw-fixture-drama.log 2>&1
mkdir -p "$ARTIFACTS_ROOT/ai-league-runs"
rm -rf "$ARTIFACTS_ROOT/ai-league-runs/fixture-drama-001"
mv "$HERE/artifacts/ai-league-runs/fixture-drama-001" "$ARTIFACTS_ROOT/ai-league-runs/fixture-drama-001"
npx tsx src/scripts/proxywar-fixture-episode-from-run.ts \
  --run-dir="$ARTIFACTS_ROOT/ai-league-runs/fixture-drama-001" \
  --run-id=fixture-drama-001 \
  --out="$FIXTURE_ROOT/drama-episode.json"

log "==> writing identity registry + league mirror (upcoming premiere card only, for now)"
UPCOMING_ISO="$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")"
cat > "$FIXTURE_ROOT/premiere-upcoming.json" <<EOF
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

log "==> starting origin (needed for the premiere admission leak audit)"
stop_origin
rm -rf "$PREMIERE_STATE_ROOT"
mkdir -p "$PREMIERE_STATE_ROOT"
chmod 700 "$PREMIERE_STATE_ROOT"
start_origin
wait_for_origin

log "==> generating live premiere match (short, so it plays out to revealed quickly)"
mkdir -p "$FIXTURE_ROOT/admit-manifests" "$ADMIT_STAGING"
rm -f "$FIXTURE_ROOT/admit-manifests"/*.json
for name in aggressive defensive diplomatic opportunistic; do
  cat > "$FIXTURE_ROOT/admit-manifests/$name.json" <<EOF
{
  "schemaVersion": 1,
  "agentName": "Fixture $name",
  "profile": "$name",
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
  --disable-alliance-actions \
  --max-steps=6 \
  --turns-per-decision-step=50 \
  --replay-tail-turns=300 \
  --playback-turn-interval-ms=200 > /tmp/pw-fixture-premiere.log 2>&1
BUNDLE="$ADMIT_STAGING/fixture-premiere-live.source.json"
SHA="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"

mkdir -p "$ADMIT_STAGING"
if [ ! -f "$ADMIT_STAGING/nonce.bin" ]; then
  python3 -c "import os;open('$ADMIT_STAGING/nonce.bin','wb').write(os.urandom(32))"
  chmod 600 "$ADMIT_STAGING/nonce.bin"
fi
python3 - "$BUNDLE" "$ADMIT_STAGING" <<'PY'
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
    "matchFormat": {"id": "ffa-4", "label": "4-seat FFA", "seatCount": 4},
    "scheduledAt": iso(now),
    "playbackRate": 1,
    "checkpoints": [
        {"id": "cp_00000001", "sequence": int(tc * 0.35)},
        {"id": "cp_00000002", "sequence": int(tc * 0.65)},
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

log "==> restarting origin onto the admitted premiere (admission never hot-registers)"
stop_origin
start_origin
wait_for_origin

URL="${ORIGIN}"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "${URL}/premiere/prem_fixture0premiere01" || true)"
echo
echo "    fixture public product live at ${URL}"
echo "    premiere http ${CODE}"
echo "    pid $(cat "$PIDFILE" 2>/dev/null || echo unknown), log $LOGFILE"
echo "    stop with: kill \$(cat $PIDFILE)"
