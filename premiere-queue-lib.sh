# Shared queue mechanics for the real-premiere pipeline, sourced by both
# `generate-premiere-queue.sh` (producer) and `cycle-premiere.sh` (consumer).
#
# The queue is a directory of READY-TO-ADMIT bundles: each item is its own
# subdirectory of $PW_QUEUE_ROOT/ready/ containing `bundle.source.json` (the
# `proxywar_rated_coworld_source` bundle `replay-premiere-admit.ts` accepts)
# plus `meta.json` (the fields needed to build admission inputs without
# re-parsing the bundle: map, seatCount, turnCount, checkpointTurns, sha256).
#
# Deliberately outside ~/Documents (TCC) and outside $STATE_PARENT (wiped
# every cycle by cycle-premiere.sh) - a queued bundle must survive the state
# root being nuked, since it hasn't been admitted yet.
#
# Item directory names are `<UTC timestamp>-<runId>`. Lexical sort on that
# prefix IS chronological order, so `sort | head -1` always picks the oldest
# - a plain FIFO with no separate sequence counter to keep in sync.
#
# Consuming an item is one `mv` out of ready/. `mv` from a path that no
# longer exists fails atomically, so two processes racing to claim the same
# item can never both succeed - the loser just sees "nothing to claim" and
# falls through to its own fallback. In practice only one process ever
# claims (cycle-premiere.sh, invoked serially by autocycle-premiere.sh), but
# the mechanism costs nothing extra and removes the need to reason about it.

PW_QUEUE_ROOT="${PW_BET_QUEUE_DIR:-$HOME/.proxywar-deploy/premiere-queue}"
PW_QUEUE_READY_DIR="$PW_QUEUE_ROOT/ready"
PW_QUEUE_WORK_DIR="$PW_QUEUE_ROOT/work"
PW_QUEUE_COST_LEDGER="$PW_QUEUE_ROOT/cost-ledger.jsonl"

pq_init() {
  mkdir -p "$PW_QUEUE_READY_DIR" "$PW_QUEUE_WORK_DIR"
  chmod 700 "$PW_QUEUE_ROOT" "$PW_QUEUE_READY_DIR" "$PW_QUEUE_WORK_DIR" 2>/dev/null || true
}

# Number of ready-to-admit items currently queued.
pq_depth() {
  local n
  n="$(ls -1 "$PW_QUEUE_READY_DIR" 2>/dev/null | wc -l | tr -d ' ')"
  echo "${n:-0}"
}

# Claims the oldest ready item by moving it into $1 (must not already
# exist). Prints the claimed item's original name on success. Returns 1,
# printing nothing, when the queue is empty - the caller's cue to fall back.
pq_claim() {
  local dest="$1" item
  item="$(ls -1 "$PW_QUEUE_READY_DIR" 2>/dev/null | sort | head -1)"
  [ -z "$item" ] && return 1
  if mv "$PW_QUEUE_READY_DIR/$item" "$dest" 2>/dev/null; then
    echo "$item"
    return 0
  fi
  # Lost a race (should not happen with a single consumer) - report empty
  # rather than a false claim.
  return 1
}

# Publishes a completed staging directory (built by the producer under
# $PW_QUEUE_WORK_DIR, containing bundle.source.json + meta.json) into ready/ as
# one atomic rename. Never publishes a partial item: the producer only
# calls this once both files are fully written.
pq_publish() {
  local tmp_dir="$1" item_name="$2"
  mv "$tmp_dir" "$PW_QUEUE_READY_DIR/$item_name"
}
