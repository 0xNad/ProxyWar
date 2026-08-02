#!/usr/bin/env bash
# Keep a shallow queue of ready-to-admit REAL league premiere bundles topped
# up, so cycle-premiere.sh can admit near-instantly instead of blocking on a
# real ~16-minute Coworld generation.
#
#   ./generate-premiere-queue.sh          # runs forever, polling
#   ./generate-premiere-queue.sh --once   # single attempt then exit (manual
#                                          # runs, testing, cron-style callers)
#
# Generation is decoupled from admission on purpose: a 16-minute generation
# only fits inside a ~26-minute cycle if it STARTS while the previous match
# is still playing. This loop is reactive, not scheduled - the moment the
# queue drops below its target depth (i.e. the moment cycle-premiere.sh
# claims the one spare bundle) it starts building the next one, which is
# exactly "while the current match plays" without needing to know the
# current match's remaining runtime.
#
# OPERATOR-GATED, same posture as generate-xp-request-episode.ts itself:
# every successful attempt is a real, billed Coworld episode. Run this under
# a supervisor (launchd/hub), never as a one-off foreground blocker.
#
# Cost controls (env, all optional):
#   PW_QUEUE_GENERATE_ENABLED=false        kill switch. Queue just never
#                                           tops up; cycling always falls
#                                           back to a local exhibition.
#   PW_QUEUE_MAX_PER_HOUR / _PER_DAY       hard caps on attempts (success OR
#                                           failure both count - a failed
#                                           attempt can still have run a real
#                                           episode on the platform before
#                                           failing downstream). Defaults
#                                           below are sized for the nominal
#                                           cadence with headroom for one
#                                           retry, not for unattended abuse.
#   PW_QUEUE_TARGET_DEPTH                  spare bundles to keep ready.
#
# Failure handling: a failed step is logged with its reason and the loop
# backs off and retries later - it never wedges, never spins tight, and
# never silently drops a step's own diagnostic output. Roster drift: every
# attempt calls generate-xp-request-episode.ts fresh, which itself pulls
# the live active roster at call time (fetchActiveLeagueRoster) - nothing
# here freezes or caches a roster snapshot across attempts.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
# shellcheck source=./premiere-queue-lib.sh
source "$HERE/premiere-queue-lib.sh"

LOGTAG="[queue-gen]"
log() { printf '%s %s %s\n' "$(date -u +%H:%M:%S)" "$LOGTAG" "$*"; }
warn() { printf '%s %s !! %s\n' "$(date -u +%H:%M:%S)" "$LOGTAG" "$*"; }

TARGET_DEPTH="${PW_QUEUE_TARGET_DEPTH:-1}"
POLL_SECONDS="${PW_QUEUE_POLL_SECONDS:-60}"
FAILURE_BACKOFF_SECONDS="${PW_QUEUE_FAILURE_BACKOFF_SECONDS:-180}"
GENERATE_ENABLED="${PW_QUEUE_GENERATE_ENABLED:-true}"
MAX_PER_HOUR="${PW_QUEUE_MAX_PER_HOUR:-4}"
MAX_PER_DAY="${PW_QUEUE_MAX_PER_DAY:-80}"
GENERATE_TIMEOUT_SECONDS="${PW_QUEUE_GENERATE_TIMEOUT_SECONDS:-1800}"
STEP_TIMEOUT_SECONDS="${PW_QUEUE_STEP_TIMEOUT_SECONDS:-300}"
# 21.6min: matches today's exhibition cadence (10800 turns x 120ms), so a
# real match trades on the same rhythm autocycle's lead/grace defaults were
# tuned for. Real turn counts vary per episode, so the interval is derived
# AFTER generation from the episode's own turnCount, not hardcoded.
TARGET_MATCH_MS="${PW_QUEUE_TARGET_MATCH_MS:-1296000}"
MIN_TURN_INTERVAL_MS=20
MAX_TURN_INTERVAL_MS=2000

# proxywar-ffa-16p (self-published, owner=proxywar): declares seats as a
# RANGE 8-16, so today's 14-agent roster fits and the league can grow to 16
# without another republish. See docs/project-state (AllSeats session).
COWORLD_ID="${PW_QUEUE_COWORLD_ID:-cow_6651aca3-2beb-49b9-9b6b-2573b4be5a63}"
VARIANT_ID="${PW_QUEUE_VARIANT_ID:-sixteen-player-ffa-world}"
MAX_DECISION_STEPS="${PW_QUEUE_MAX_DECISION_STEPS:-300}"
# The package's own ceiling. --max-seats is NOT on the live path today (roster
# is 14, well under 16) - this is a safety net, not a truncation policy. When
# it does fire (roster > 16) generate-xp-request-episode.ts already logs
# exactly who got excluded; this script escalates that line to a WARN
# instead of letting it scroll past in an INFO stream, so growth past the
# package's capacity is never silently absorbed.
MAX_SEATS="${PW_QUEUE_MAX_SEATS:-16}"

ONCE=false
[ "${1:-}" = "--once" ] && ONCE=true

pq_init

# Runs "$@" in its own process group (so a timeout kill takes any child
# processes with it - npm spawns tsx spawns node) with output captured to
# $OUT. Returns 124 on timeout, the command's own exit code otherwise.
run_step() {
  local secs="$1" out="$2"
  shift 2
  python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    "$@" >"$out" 2>&1 &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill -TERM "-$pid" 2>/dev/null || true
      sleep 3
      kill -KILL "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 2
    waited=$((waited + 2))
  done
  wait "$pid"
}

# Attempts (success or failure - both are billable once generation starts)
# in the last hour/day, from the durable cost ledger. Restart-safe: no
# separate rate-limit state to lose, just the ledger itself.
rate_counts() {
  python3 - "$PW_QUEUE_COST_LEDGER" <<'PY'
import json, sys, datetime
path = sys.argv[1]
now = datetime.datetime.now(datetime.timezone.utc)
hour_ago = now - datetime.timedelta(hours=1)
day_ago = now - datetime.timedelta(days=1)
hour_n = day_n = 0
try:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                t = datetime.datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
            except Exception:
                continue
            if t >= day_ago:
                day_n += 1
            if t >= hour_ago:
                hour_n += 1
except FileNotFoundError:
    pass
print(f"{hour_n} {day_n}")
PY
}

# Appends one reconciliation row. Cross-reference episodeId/experienceRequestId
# against Softmax billing to true up actual spend; this ledger only records
# that an attempt happened and how it ended, not a dollar figure (the
# platform does not surface cost_usd through this API surface today).
ledger_append() {
  python3 - "$PW_QUEUE_COST_LEDGER" "$@" <<'PY'
import json, sys, datetime
path = sys.argv[1]
result, reason, run_id, episode_id, xreq_id, wall_s, turns, seats = (sys.argv[2:10] + [""] * 8)[:8]
row = {
    "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    "result": result,
    "reason": reason or None,
    "runId": run_id or None,
    "episodeId": episode_id or None,
    "experienceRequestId": xreq_id or None,
    "wallClockSeconds": float(wall_s) if wall_s else None,
    "turnCount": int(turns) if turns else None,
    "seatCount": int(seats) if seats else None,
}
with open(path, "a") as f:
    f.write(json.dumps(row) + "\n")
PY
}

# One full generate -> seal -> build-source attempt. Publishes into the
# ready queue and returns 0 on success; logs a reason and returns 1 on any
# failure, having cleaned up its own partial work.
attempt_generate() {
  local started ended wall
  started="$(date +%s)"
  local work_tmp; work_tmp="$(mktemp -d "$PW_QUEUE_WORK_DIR/attempt-XXXXXX")"
  local gen_log="$work_tmp/generate.log"

  log "generating: coworld=${COWORLD_ID} variant=${VARIANT_ID} max-decision-steps=${MAX_DECISION_STEPS} max-seats=${MAX_SEATS}"
  run_step "$GENERATE_TIMEOUT_SECONDS" "$gen_log" \
    npm run premiere-wagering:generate -- \
    --coworld-id="$COWORLD_ID" \
    --variant-id="$VARIANT_ID" \
    --max-decision-steps="$MAX_DECISION_STEPS" \
    --max-seats="$MAX_SEATS" \
    --runs-root="$PW_QUEUE_WORK_DIR/runs"
  local gen_status=$?
  ended="$(date +%s)"; wall=$((ended - started))

  local bundle_dir
  bundle_dir="$(grep -oE '^bundle written -> \S+' "$gen_log" | awk '{print $4}' | tail -1)"
  local roster_line; roster_line="$(grep -E '^active roster: ' "$gen_log" | tail -1)"
  [ -n "$roster_line" ] && log "$roster_line"
  local trim_line; trim_line="$(grep -E '^--max-seats=.* trims to .* excluded this cycle: ' "$gen_log" | tail -1)"
  if [ -n "$trim_line" ]; then
    warn "roster exceeds package capacity (${MAX_SEATS} seats) - $trim_line"
  fi

  if [ "$gen_status" -ne 0 ] || [ -z "$bundle_dir" ]; then
    local reason
    if [ "$gen_status" -eq 124 ]; then
      reason="generate step timed out after ${GENERATE_TIMEOUT_SECONDS}s"
    else
      reason="$(grep -oE 'PREMIERE_WAGERING_GENERATE_FAILED.*' "$gen_log" | tail -1)"
      [ -z "$reason" ] && reason="generate step exited ${gen_status} with no bundle dir"
    fi
    warn "generation FAILED at generate step: $reason"
    ledger_append failure "$reason" "" "" "" "$wall" "" ""
    rm -rf "$work_tmp"
    return 1
  fi

  local roster_json="$bundle_dir/xp-request-roster.json"
  if [ ! -f "$roster_json" ]; then
    warn "generation FAILED: bundle dir has no xp-request-roster.json ($bundle_dir)"
    ledger_append failure "missing xp-request-roster.json" "" "" "" "$wall" "" ""
    rm -rf "$work_tmp" "$bundle_dir"
    return 1
  fi
  local map episode_id xreq_id turn_count
  read -r map episode_id xreq_id turn_count < <(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get("map") or "unknown", d.get("episodeId") or "", d.get("experienceRequestId") or "", d.get("turnCount") or 0)
' "$roster_json")

  log "sealing: bundle-dir=$bundle_dir"
  local seal_log="$work_tmp/seal.log"
  run_step "$STEP_TIMEOUT_SECONDS" "$seal_log" \
    npm run premiere-wagering:seal -- --bundle-dir="$bundle_dir" --source=xp-request
  if [ $? -ne 0 ]; then
    local reason; reason="$(grep -oE 'PREMIERE_WAGERING_SEAL_(REFUSED|FAILED).*' "$seal_log" | tail -1)"
    [ -z "$reason" ] && reason="seal step failed"
    warn "generation FAILED at seal step: $reason"
    ledger_append failure "$reason" "" "$episode_id" "$xreq_id" "$wall" "$turn_count" ""
    rm -rf "$work_tmp" "$bundle_dir"
    return 1
  fi

  # Derive a turn interval that lands this episode's playback near the
  # target match duration, clamped to a sane range - turnCount is only
  # known now, post-generation.
  local interval_ms
  interval_ms="$(python3 -c "
tc = max(int(\"$turn_count\") or 1, 1)
ms = round($TARGET_MATCH_MS / tc)
print(max($MIN_TURN_INTERVAL_MS, min($MAX_TURN_INTERVAL_MS, ms)))
")"

  local publish_tmp="$work_tmp/publish"
  mkdir -p "$publish_tmp"
  log "building source bundle: turn-interval-ms=$interval_ms"
  local build_log="$work_tmp/build-source.log"
  run_step "$STEP_TIMEOUT_SECONDS" "$build_log" \
    npm run premiere-wagering:build-source -- \
    --bundle-dir="$bundle_dir" \
    --turn-interval-ms="$interval_ms" \
    --out-file="$publish_tmp/bundle.source.json"
  if [ $? -ne 0 ]; then
    local reason; reason="$(grep -oE 'PREMIERE_WAGERING_BUILD_SOURCE_FAILED.*' "$build_log" | tail -1)"
    [ -z "$reason" ] && reason="build-source step failed"
    warn "generation FAILED at build-source step: $reason"
    ledger_append failure "$reason" "" "$episode_id" "$xreq_id" "$wall" "$turn_count" ""
    rm -rf "$work_tmp" "$bundle_dir"
    return 1
  fi

  # buildRatedPremiereSourceBundle's result JSON is the one line in stdout
  # that parses and has an outFile key.
  local result_json
  result_json="$(python3 -c '
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        row = json.loads(line)
    except Exception:
        continue
    if "outFile" in row:
        print(json.dumps(row))
        break
' "$build_log")"
  if [ -z "$result_json" ]; then
    warn "generation FAILED: could not parse build-source result"
    ledger_append failure "unparseable build-source result" "" "$episode_id" "$xreq_id" "$wall" "$turn_count" ""
    rm -rf "$work_tmp" "$bundle_dir"
    return 1
  fi

  local run_id sha256 seat_count cp_a cp_b
  read -r run_id sha256 seat_count cp_a cp_b < <(python3 -c '
import json, sys
r = json.loads(sys.argv[1])
a, b = r["checkpointTurns"]
print(r["sourceRunId"], r["bundleSha256"], r["seatCount"], a, b)
' "$result_json")

  python3 -c "
import json, sys, datetime
meta = {
    'schemaVersion': 1,
    'kind': 'real-league',
    'runId': '$run_id',
    'sourceFile': 'bundle.source.json',
    'sha256': '$sha256',
    'turnCount': int('$turn_count'),
    'seatCount': int('$seat_count'),
    'map': '$map',
    'checkpointTurns': [int('$cp_a'), int('$cp_b')],
    'turnIntervalMs': int('$interval_ms'),
    'coworldId': '$COWORLD_ID',
    'variantId': '$VARIANT_ID',
    'episodeId': '$episode_id',
    'experienceRequestId': '$xreq_id',
    'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
}
json.dump(meta, open('$publish_tmp/meta.json', 'w'), indent=2)
"

  local item_name; item_name="$(date -u +%Y%m%dT%H%M%SZ)-${run_id}"
  pq_publish "$publish_tmp" "$item_name"
  # The raw episode artifacts (decisions.jsonl, spectator-replay.json, ...)
  # are fully superseded by bundle.source.json, which embeds the game record - keep
  # this from growing without bound at roughly one real episode per cycle,
  # forever.
  rm -rf "$work_tmp" "$bundle_dir"

  ledger_append success "" "$run_id" "$episode_id" "$xreq_id" "$wall" "$turn_count" "$seat_count"
  log "published ${item_name} (turns=${turn_count} seats=${seat_count} map=${map} wall=${wall}s)"
  return 0
}

log "starting (queue=$PW_QUEUE_ROOT target-depth=$TARGET_DEPTH enabled=$GENERATE_ENABLED caps=${MAX_PER_HOUR}/h,${MAX_PER_DAY}/d coworld=${COWORLD_ID}/${VARIANT_ID})"

while true; do
  depth="$(pq_depth)"
  if [ "$depth" -ge "$TARGET_DEPTH" ]; then
    log "queue depth ${depth}/${TARGET_DEPTH} - topped up"
    $ONCE && exit 0
    sleep "$POLL_SECONDS"; continue
  fi

  if [ "$GENERATE_ENABLED" != "true" ]; then
    log "generation DISABLED (PW_QUEUE_GENERATE_ENABLED=$GENERATE_ENABLED) - depth ${depth}/${TARGET_DEPTH}, cycling will fall back to exhibitions"
    $ONCE && exit 3
    sleep "$POLL_SECONDS"; continue
  fi

  read -r hour_count day_count < <(rate_counts)
  if [ "$hour_count" -ge "$MAX_PER_HOUR" ]; then
    warn "cost cap reached: ${hour_count}/${MAX_PER_HOUR} attempts in the last hour - waiting"
    $ONCE && exit 4
    sleep "$POLL_SECONDS"; continue
  fi
  if [ "$day_count" -ge "$MAX_PER_DAY" ]; then
    warn "cost cap reached: ${day_count}/${MAX_PER_DAY} attempts in the last 24h - waiting"
    $ONCE && exit 4
    sleep "$POLL_SECONDS"; continue
  fi

  log "depth ${depth}/${TARGET_DEPTH} (hour ${hour_count}/${MAX_PER_HOUR}, day ${day_count}/${MAX_PER_DAY}) - starting a real generation"
  if attempt_generate; then
    $ONCE && exit 0
  else
    log "backing off ${FAILURE_BACKOFF_SECONDS}s after failure"
    $ONCE && exit 1
    sleep "$FAILURE_BACKOFF_SECONDS"; continue
  fi
  sleep "$POLL_SECONDS"
done
