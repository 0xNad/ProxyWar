#!/usr/bin/env bash
# Cycle the hosted betting demo onto a fresh live premiere.
#
#   ./cycle-premiere.sh [lead-minutes]
#
# Generates a new controlled-exhibition match, resets the premiere state root,
# admits the match against the public origin, and brings the origin back up on
# it. Prints the URL. Default lead time is 4 minutes: enough for the restart
# plus a browser to be open before trading opens.
#
# This REPLACES whatever premiere was live. The state root is wiped every run,
# which is deliberate - the demo surface shows one live market at a time, and
# a root accumulates unusable admissions after a few cycles otherwise
# (premiere_not_registered, RUNBOOK 13.6). Any in-flight session, position, or
# bankroll on the previous premiere is destroyed with it.
#
# Requires: the origin manageable under the name below, and nothing else
# holding the state root's single-writer lock.
set -euo pipefail

LEAD_MIN="${1:-4}"
ORIGIN="https://bet.proxywar.xyz"
ORIGIN_PORT=8792
PIDFILE="/tmp/pw-bet-origin.pid"
LOGFILE="/tmp/pw-bet-origin.log"
STATE_PARENT="$HOME/.proxywar-bet-live"
STATE_ROOT="$STATE_PARENT/replay-premiere"
# Deliberately OUTSIDE $STATE_PARENT, which this script deletes every cycle.
GUEST_KEY_FILE="${PW_BET_GUEST_KEY_FILE:-$HOME/.proxywar-deploy/guest-hmac-key.hex}"
# Likewise the points ledger: durable across cycles, so a returning player
# keeps their score.
POINTS_LEDGER_ROOT="${PROXYWAR_POINTS_LEDGER_ROOT:-$HOME/.proxywar-deploy/points-ledger}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
# The leak audit fetches the PUBLIC origin and requires a 200 from /league, so
# the origin must serve real league artifacts. Defaults to this checkout's own
# artifacts/, which is correct for a standalone deploy; point
# PROXYWAR_ARTIFACTS_ROOT elsewhere when running out of a dev repo whose
# artifacts/ is empty.
ARTIFACTS_ROOT="${PROXYWAR_ARTIFACTS_ROOT:-$HERE/artifacts}"
STAGING="${PW_BET_STAGING_DIR:-/tmp/pw-bet-staging}"
# Agent manifests need a policyIdentity the shared docs copies lack, so they
# get staged into their own directory rather than edited in place.
MANIFESTS="${PW_BET_MANIFEST_DIR:-/tmp/pw-bet-manifests}"
ADMIT_IN="${PW_BET_ADMIT_DIR:-/private/tmp/pw-bet-admit}"
# Match length = 10800 turns x this interval. Longer matches mean a smaller
# share of the cycle spent between markets: at 120ms a match runs ~21.6min
# against roughly 5min of settled-plus-scheduled gap, versus 12.6min against
# the same gap at 70ms. The hard ceiling is REPLAY_PREMIERE_MAX_CHUNK_COUNT
# (128) x 60s spans, about 2h08m, so there is plenty of headroom.
TURN_INTERVAL_MS="${PW_BET_TURN_INTERVAL_MS:-120}"

RUN_ID="bet-cycle-$(date +%s)"
# prem_ + exactly 20 lowercase alphanumerics. openssl, not `tr </dev/urandom`,
# which exits 141 on SIGPIPE and takes the script down under pipefail.
PREMIERE_ID="prem_$(openssl rand -hex 10)"

stop_origin() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # Kill the process group: npx spawns tsx spawns node, and killing only
      # the parent leaves the real listener holding the port and the state
      # root's single-writer lock.
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -KILL "-$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  # Anything still on the port would silently shadow us - but only ever kill
  # something we can positively identify as this demo's own origin. Other
  # servers share this machine, including the production league.
  local squatters pid cmd
  squatters="$(lsof -ti tcp:"$ORIGIN_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $squatters; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *ai-agent-demo-server*)
        kill -TERM "$pid" 2>/dev/null || true ;;
      *)
        echo "    !! port ${ORIGIN_PORT} held by pid ${pid}, which is not this demo:"
        echo "       ${cmd}"
        echo "       Refusing to kill it. Free the port or change ORIGIN_PORT."
        return 1 ;;
    esac
  done
  if [ -n "$squatters" ]; then sleep 2; fi
  return 0
}

# The guest HMAC key normally lives INSIDE the premiere state root, which this
# script deletes every cycle. Losing it invalidates every signed guest cookie,
# so returning players silently become brand-new participants and the points
# ledger fragments into one-cycle ghosts. Keep the key outside the wiped root
# and hand it to the server explicitly, so a browser keeps its identity - and
# its leaderboard entry - across cycles.
ensure_guest_key() {
  if [ -s "$GUEST_KEY_FILE" ]; then return 0; fi
  mkdir -p "$(dirname "$GUEST_KEY_FILE")"
  openssl rand -hex 32 >"$GUEST_KEY_FILE"
  chmod 600 "$GUEST_KEY_FILE"
  echo "    minted a new guest identity key (first run): $GUEST_KEY_FILE"
  echo "    deleting it will reset every player's identity and leaderboard row."
}

start_origin() {
  ensure_guest_key
  # Own process group, so stop_origin can take down the whole
  # npx -> tsx -> node chain in one signal. macOS has no setsid(1), so call
  # setsid(2) via python and exec the server in its place.
  GAME_ENV=dev \
  PROXYWAR_REPLAY_PREMIERE_HMAC_KEY_HEX="$(cat "$GUEST_KEY_FILE")" \
  PROXYWAR_POINTS_LEDGER_ROOT="$POINTS_LEDGER_ROOT" \
  AI_LEAGUE_DEMO_PORT="$ORIGIN_PORT" \
  PROXYWAR_PUBLIC_URL="$ORIGIN" \
  PROXYWAR_WAGERING_ENABLED=1 \
  PROXYWAR_SYNTHETIC_CROWD_ENABLED=true \
  PROXYWAR_REPLAY_PREMIERE_STATE_ROOT="$STATE_ROOT" \
  PROXYWAR_LEAGUE_WRAPPER_ONLY=true \
  PROXYWAR_ARTIFACTS_ROOT="$ARTIFACTS_ROOT" \
  nohup python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    npx tsx src/scripts/ai-agent-demo-server.ts >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
}

restart_origin() {
  stop_origin
  start_origin
}

wait_for_origin() {
  for _ in $(seq 1 40); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
            "http://127.0.0.1:${ORIGIN_PORT}/league" || true)" = "200" ]; then
      return 0
    fi
    sleep 2
  done
  echo "    !! origin did not come back on port ${ORIGIN_PORT}"
  return 1
}

echo "==> generating match bundle ${RUN_ID}"
mkdir -p "$STAGING"
GAME_ENV=dev npx tsx src/scripts/replay-premiere-controlled-exhibition.ts \
  --run-id="$RUN_ID" \
  --private-output-root="$STAGING" \
  --agent-manifest-dir="$MANIFESTS" \
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
  --playback-turn-interval-ms="$TURN_INTERVAL_MS" >/dev/null 2>&1

BUNDLE="${STAGING}/${RUN_ID}.source.json"
SHA="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"

# Checkpoints land at 35% / 65% of turnCount, matching
# checkpointSequencesForTurnCount in ReplayPremiereLoopCore.ts.
echo "==> writing admission inputs (lead ${LEAD_MIN}m)"
mkdir -p "$ADMIT_IN"
if [ ! -f "$ADMIT_IN/nonce.bin" ]; then
  python3 -c "import os;open('$ADMIT_IN/nonce.bin','wb').write(os.urandom(32))"
  chmod 600 "$ADMIT_IN/nonce.bin"
fi
python3 - "$BUNDLE" "$LEAD_MIN" "$ADMIT_IN" <<'PY'
import json, os, sys, datetime
bundle, lead, admit_in = sys.argv[1], int(sys.argv[2]), sys.argv[3]
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
    "title": "Proxy War Live Market - Which AI policy wins?",
    "spoilerNeutralDescription":
        "Four autonomous AI policies compete on Asia. Trade on the outcome while it unfolds.",
    "map": {"id": "Asia", "label": "Asia"},
    "matchFormat": {"id": "ffa-4", "label": "4-seat FFA", "seatCount": 4},
    "scheduledAt": iso(now + datetime.timedelta(minutes=lead)),
    "playbackRate": 1,
    "checkpoints": [
        {"id": "cp_00000001", "sequence": int(tc * 0.35)},
        {"id": "cp_00000002", "sequence": int(tc * 0.65)},
    ],
}, open(os.path.join(admit_in, "definition.json"), "w"), indent=2)
print(f"    turns={tc} duration={tc*d['replay']['turnIntervalMs']/60000:.1f}min")
PY

# The state root must be empty before admitting or the catalog fills with
# unusable records. It also must be 0700, or the server refuses to boot with
# private_state_root_not_private. Stop the origin first: it holds a
# single-writer lock on the root.
echo "==> resetting state root"
stop_origin
rm -rf "$STATE_PARENT"
mkdir -p "$STATE_ROOT"
chmod 700 "$STATE_PARENT" "$STATE_ROOT"

# Admission's leak audit fetches the PUBLIC origin and needs a 200 from
# /league, so the origin has to be serving before we admit - even though it
# does not yet know about this premiere.
echo "==> bringing origin up for the leak audit"
restart_origin
wait_for_origin

echo "==> admitting ${PREMIERE_ID}"
GAME_ENV=dev PROXYWAR_PUBLIC_URL="$ORIGIN" npx tsx src/scripts/replay-premiere-admit.ts \
  --premiere-id="$PREMIERE_ID" \
  --source-file="$BUNDLE" \
  --expected-source-sha256="$SHA" \
  --private-state-root="$STATE_ROOT" \
  --served-root="$(pwd)" --served-root="$(pwd)/static" --served-root="$(pwd)/artifacts" \
  --served-root="$(pwd)/docs" --served-root="$(pwd)/examples/external-agent" \
  --eligibility-file="$ADMIT_IN/eligibility.json" \
  --definition-file="$ADMIT_IN/definition.json" \
  --deployment-origin="$ORIGIN" \
  --nonce-file="$ADMIT_IN/nonce.bin" >/dev/null 2>&1

# Admission never hot-registers; the catalog is rebuilt at boot.
echo "==> restarting origin onto the new premiere"
restart_origin
wait_for_origin

URL="${ORIGIN}/bet/${PREMIERE_ID}"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$URL" || true)"
echo
echo "    ${URL}"
echo "    http ${CODE} - trading opens in ~${LEAD_MIN}m"
[ "$CODE" = "200" ]
