#!/usr/bin/env bash
# Cycle the hosted betting demo onto a fresh live premiere.
#
#   ./cycle-premiere.sh [lead-minutes]
#
# Admits a match against the public origin, resets the premiere state root,
# and brings the origin back up on it. Prints the URL. Default lead time is
# 4 minutes: enough for the restart plus a browser to be open before trading
# opens.
#
# The match itself comes from one of two places, in priority order:
#
#   1. The real-league premiere queue (premiere-queue-lib.sh), topped up in
#      the background by generate-premiere-queue.sh. Claiming a queued item
#      is a local mv, so this path is near-instant - the ~16-minute Coworld
#      generation already happened earlier, while the PREVIOUS match was
#      still playing.
#   2. A freshly generated local exhibition, exactly like this script always
#      did before the queue existed. This is the fallback for an empty
#      queue (generator behind, disabled, or rate-capped) - a synthetic
#      match is a worse product than a real one, but no market at all is
#      worse than either, so the URL never goes dark waiting on generation.
#
# Which one actually went live is logged loudly (`MATCH KIND: ...`) and
# recorded in /tmp/pw-bet-last-cycle.json for autocycle-premiere.sh to
# surface - a run of fallback exhibitions must never look like real league
# matches in the log stream.
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
# GitHub OAuth credentials, outside the wiped state root. The client id is not
# secret. The secret file must be 0600, and the server is handed its PATH
# rather than its contents - `ps eww <pid>` dumps a process's environment, so
# an exported secret is one command away from anyone on this box.
GITHUB_CLIENT_ID_FILE="${PW_BET_GITHUB_CLIENT_ID_FILE:-$HOME/.proxywar-deploy/github-oauth-client-id}"
GITHUB_CLIENT_SECRET_FILE="${PW_BET_GITHUB_CLIENT_SECRET_FILE:-$HOME/.proxywar-deploy/github-oauth-client-secret}"
# The live league's own public standings feed. Not the deploy's copy.
LEAGUE_DATA_URL="${PW_BET_LEAGUE_DATA_URL:-https://beta.proxywar.xyz/ai-league-runs/league/data.json}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
# shellcheck source=./premiere-queue-lib.sh
source "$HERE/premiere-queue-lib.sh"
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

# The scouting panel reads league standings from this deploy's own
# artifacts/. That file is a COPY, and its own `stale` flag is copied with
# it - so a snapshot taken hours ago keeps asserting `stale:false` and the
# panel presents old ratings as current. Confidently wrong is worse than
# absent, so refresh it from the live league every cycle, and if that fails,
# mark the local copy stale so the panel says so instead of lying.
refresh_league_data() {
  local dest tmp
  dest="$ARTIFACTS_ROOT/ai-league-runs/league/data.json"
  [ -f "$dest" ] || return 0
  tmp="${dest}.fetch.$$"
  if curl -s --fail -m 30 "$LEAGUE_DATA_URL" -o "$tmp" 2>/dev/null &&
     python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get('standings') else 1)" "$tmp" 2>/dev/null; then
    mv "$tmp" "$dest"
    echo "    league data refreshed"
  else
    rm -f "$tmp"
    python3 - "$dest" <<'PY' 2>/dev/null || true
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception:
    sys.exit(0)
if d.get("stale") is not True:
    d["stale"] = True
    json.dump(d, open(p, "w"))
PY
    echo "    !! league data refresh FAILED - local copy marked stale"
  fi
}

start_origin() {
  ensure_guest_key
  # GitHub OAuth, when configured. The client id is not a secret and is passed
  # normally. The SECRET is passed as a FILE PATH, never a value: `ps eww <pid>`
  # dumps a process's whole environment, so exporting the secret would put it a
  # single command away from anyone on this machine. The server reads and trims
  # the 0600 file itself. A missing file means sign-in cleanly does not exist -
  # no button, no broken route.
  #
  # The HMAC key below is a pre-existing exception, not a precedent: it predates
  # this and is worth moving to the same file-path treatment.
  # Own process group, so stop_origin can take down the whole
  # npx -> tsx -> node chain in one signal. macOS has no setsid(1), so call
  # setsid(2) via python and exec the server in its place.
  GAME_ENV=dev \
  PROXYWAR_REPLAY_PREMIERE_HMAC_KEY_HEX="$(cat "$GUEST_KEY_FILE")" \
  PROXYWAR_POINTS_LEDGER_ROOT="$POINTS_LEDGER_ROOT" \
  PROXYWAR_GITHUB_OAUTH_CLIENT_ID="${PROXYWAR_GITHUB_OAUTH_CLIENT_ID:-$(cat "$GITHUB_CLIENT_ID_FILE" 2>/dev/null || true)}" \
  PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE="$GITHUB_CLIENT_SECRET_FILE" \
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

echo "==> checking premiere queue"
mkdir -p "$STAGING"
rm -rf "$STAGING/queue-claim"
QUEUE_ITEM=""
if QUEUE_ITEM="$(pq_claim "$STAGING/queue-claim")"; then
  MATCH_KIND="real-league"
  BUNDLE="$STAGING/queue-claim/bundle.source.json"
  META_FILE="$STAGING/queue-claim/meta.json"
  echo "==> MATCH KIND: real-league (queue item ${QUEUE_ITEM}; queue depth now $(pq_depth))"
else
  MATCH_KIND="exhibition"
  META_FILE=""
  echo "==> MATCH KIND: exhibition (fallback - real-league queue is empty)"
  echo "==> generating match bundle ${RUN_ID}"
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
fi

SHA="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"

# Exhibition checkpoints land at 35% / 65% of turnCount, matching
# checkpointSequencesForTurnCount in ReplayPremiereLoopCore.ts. Real-league
# checkpoints instead come from the queue item's own spawn-aware computation
# (PremiereWageringCheckpoints.ts, done at seal time) - see the python below.
echo "==> writing admission inputs (lead ${LEAD_MIN}m)"
mkdir -p "$ADMIT_IN"
if [ ! -f "$ADMIT_IN/nonce.bin" ]; then
  python3 -c "import os;open('$ADMIT_IN/nonce.bin','wb').write(os.urandom(32))"
  chmod 600 "$ADMIT_IN/nonce.bin"
fi
python3 - "$BUNDLE" "$LEAD_MIN" "$ADMIT_IN" "$MATCH_KIND" "$META_FILE" <<'PY'
import json, os, sys, datetime
bundle, lead, admit_in, kind, meta_file = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
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

if kind == "real-league":
    # Ground truth, read from the bundle actually being admitted - not the
    # generator's meta.json - because bootstrap.config.gameMap (what
    # admission validates definition.map.id against) is derived from
    # replaying this exact embedded gameRecord.
    seat_count = len(d["seats"])
    map_id = str(d["gameRecord"]["info"]["config"]["gameMap"])
    title = "Proxy War Live Market - Real AI League Premiere"
    description = (
        f"{seat_count} real AI league policies compete on {map_id}. "
        "Trade on the outcome while it unfolds."
    )
    match_format = {"id": f"ffa-{seat_count}", "label": f"{seat_count}-seat FFA", "seatCount": seat_count}
    map_obj = {"id": map_id, "label": map_id}
    meta = json.load(open(meta_file))
    cp_a, cp_b = meta["checkpointTurns"]
    checkpoints = [
        {"id": "cp_00000001", "sequence": int(cp_a)},
        {"id": "cp_00000002", "sequence": int(cp_b)},
    ]
else:
    title = "Proxy War Live Market - Which AI policy wins?"
    description = "Four autonomous AI policies compete on Asia. Trade on the outcome while it unfolds."
    match_format = {"id": "ffa-4", "label": "4-seat FFA", "seatCount": 4}
    map_obj = {"id": "Asia", "label": "Asia"}
    checkpoints = [
        {"id": "cp_00000001", "sequence": int(tc * 0.35)},
        {"id": "cp_00000002", "sequence": int(tc * 0.65)},
    ]

json.dump({
    "schemaVersion": 1,
    "title": title,
    "spoilerNeutralDescription": description,
    "map": map_obj,
    "matchFormat": match_format,
    "scheduledAt": iso(now + datetime.timedelta(minutes=lead)),
    "playbackRate": 1,
    "checkpoints": checkpoints,
}, open(os.path.join(admit_in, "definition.json"), "w"), indent=2)
print(f"    kind={kind} turns={tc} seats={match_format['seatCount']} duration={tc*d['replay']['turnIntervalMs']/60000:.1f}min")
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
# Before the origin serves anything, make the standings the scouting panel
# reads match reality rather than whenever this deploy was created.
echo "==> refreshing league data"
refresh_league_data

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
echo "    kind=${MATCH_KIND}${QUEUE_ITEM:+ queue-item=${QUEUE_ITEM}}"
echo "    http ${CODE} - trading opens in ~${LEAD_MIN}m"

# Consumed exactly once: fully absorbed into the admission above, so it must
# not survive to be claimed again or reused - a repeat is worse than a gap,
# since anyone who saw it already knows the winner.
if [ "$MATCH_KIND" = "real-league" ]; then
  rm -rf "$STAGING/queue-claim"
fi

# Lets autocycle-premiere.sh (and any operator) see which kind is actually
# live without re-deriving it - a fallback streak must never be mistaken for
# real league matches.
python3 -c "
import json, datetime
json.dump({
    'kind': '$MATCH_KIND',
    'premiereId': '$PREMIERE_ID',
    'queueItem': '$QUEUE_ITEM',
    'httpCode': '$CODE',
    'timestamp': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
}, open('/tmp/pw-bet-last-cycle.json', 'w'))
"

[ "$CODE" = "200" ]
