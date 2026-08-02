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

# Claims the ready/ item a scheduled `FeaturedMatch` record (state
# "published", see FeaturedMatch.ts's state-machine doc) marks as DUE -
# the operator's explicit schedule taking precedence over plain FIFO
# `pq_claim` (product overhaul spec Stage 3 item 4; full design in
# src/scripts/premiere-schedule.ts's "Autocycle coexistence" module doc).
#
# "Which item, if any" is delegated to premiere-autocycle-due.ts, a
# read-only tsx helper that reads featured-matches.json and prints the
# due item's name on stdout (nothing on no match) - this function's own
# job is only the same atomic mv pq_claim already does. $1 is the
# destination (must not already exist); $2 is the lead-minutes window,
# passed straight through to the helper (mirrors cycle-premiere.sh's own
# LEAD_MIN - admitting a record exactly that many minutes before its
# scheduledAt is what makes the market open AT scheduledAt).
#
# Returns 1, printing nothing, whenever nothing is due - including: the
# store doesn't exist yet, no record is in "published" state, every due
# record's queue item already vanished, or the helper itself fails (a
# broken schedule store must never take an operator's demo offline; it
# just falls through to plain pq_claim exactly as if no schedule
# existed). This is a pure ADDITION ahead of the existing pq_claim call -
# when it returns 1, the caller's existing FIFO/exhibition fallback chain
# runs completely unmodified.
pq_claim_scheduled_due() {
  local dest="$1" lead_minutes="$2" item
  item="$(npx tsx src/scripts/premiere-autocycle-due.ts \
    "--lead-minutes=${lead_minutes}" --queue-root="$PW_QUEUE_ROOT" 2>/dev/null)" || true
  [ -z "$item" ] && return 1
  if mv "$PW_QUEUE_READY_DIR/$item" "$dest" 2>/dev/null; then
    echo "$item"
    return 0
  fi
  # The named item vanished between the helper's read and this mv (a
  # second consumer, or the operator manually clearing ready/) - report
  # empty rather than a false claim, exactly like pq_claim's own race note.
  return 1
}
