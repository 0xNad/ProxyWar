#!/usr/bin/env bash
# Keep https://bet.proxywar.xyz/bet showing a tradeable market, indefinitely.
#
#   ./autocycle-premiere.sh
#
# Watches the premiere that /bet currently resolves to. When it has genuinely
# finished - or when the origin genuinely has nothing registered - waits out a
# grace window so late arrivals can still read the settlement card, then runs
# cycle-premiere.sh to put a fresh match up.
#
# Without this, the demo URL is only tradeable for the ~12 minutes of whatever
# match was admitted last, and shows a settled market forever afterwards.
#
# Cycling DESTROYS the current premiere and every position and bankroll on it,
# so the two rules below are load-bearing:
#
#   1. Only ever cycle on an explicitly terminal status (settled/void), never
#      on a status this script does not recognise. A scheduled premiere that
#      has not started yet must survive, whatever the lead and grace settings.
#   2. Never treat a failed request as "nothing is running". A single
#      Cloudflare blip would otherwise wipe a live market mid-trade. Emptiness
#      has to be confirmed repeatedly AND against the local origin, which is
#      not behind the tunnel.
#
# Run it under a supervisor. It holds no state across restarts and is safe to
# kill at any point.
set -uo pipefail

ORIGIN="https://bet.proxywar.xyz"
ORIGIN_PORT="${AUTOCYCLE_ORIGIN_PORT:-8792}"
LOCAL_ORIGIN="http://127.0.0.1:${ORIGIN_PORT}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# A settled market is the only genuinely dead state: there is nothing to do
# and nothing to read but a finished result. Keep it short. A SCHEDULED market
# is different - the landing page explains the product and counts down to the
# open, which is a reasonable first thirty seconds for a cold visitor - so the
# lead time is deliberately not minimised.
GRACE_SECONDS="${AUTOCYCLE_GRACE_SECONDS:-90}"
POLL_SECONDS="${AUTOCYCLE_POLL_SECONDS:-20}"
LEAD_MIN="${AUTOCYCLE_LEAD_MIN:-2}"
# Consecutive confirmed-empty polls before believing the demo is really down.
EMPTY_STRIKES="${AUTOCYCLE_EMPTY_STRIKES:-3}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Resolve via the LOCAL origin: it bypasses Cloudflare, so a tunnel hiccup
# cannot masquerade as an empty registry.
current_premiere() {
  curl -s -o /dev/null -w '%{redirect_url}' -m 20 "${LOCAL_ORIGIN}/bet" 2>/dev/null \
    | sed 's|.*/bet/||'
}

# "" on any transport failure, so callers can tell "no market" from "no answer".
market_status() {
  local body
  body="$(curl -s -m 20 --fail "${LOCAL_ORIGIN}/api/premieres/$1/market" 2>/dev/null)" || return 0
  printf '%s' "$body" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["market"]["status"])
except Exception: pass' 2>/dev/null
}

# Distinguishes "origin answered, registry is empty" from "origin did not
# answer". Only the former justifies cycling.
origin_reachable() {
  curl -s -o /dev/null --fail -m 10 "${LOCAL_ORIGIN}/league" 2>/dev/null
}

# True when nothing at all is listening. Distinguishes a cold boot (safe to
# start: no market exists) from a wedged or restarting origin that may still
# hold live positions.
port_is_free() {
  [ -z "$(lsof -ti tcp:"$ORIGIN_PORT" -sTCP:LISTEN 2>/dev/null || true)" ]
}

cycle() {
  log "cycling onto a fresh match"
  if (cd "$HERE" && ./cycle-premiere.sh "$LEAD_MIN" >/tmp/pw-bet-autocycle-run.log 2>&1); then
    log "up: $(current_premiere)"
  else
    log "!! cycle FAILED - see /tmp/pw-bet-autocycle-run.log"
    sleep 120
  fi
}

log "watching ${LOCAL_ORIGIN}/bet (grace ${GRACE_SECONDS}s, lead ${LEAD_MIN}m)"
settled_since=""
empty_polls=0
down_polls=0

while true; do
  premiere="$(current_premiere)"

  if [ -z "$premiere" ]; then
    if origin_reachable; then
      empty_polls=$((empty_polls + 1))
      log "origin up but no premiere registered (${empty_polls}/${EMPTY_STRIKES})"
      if [ "$empty_polls" -ge "$EMPTY_STRIKES" ]; then
        cycle
        empty_polls=0
        settled_since=""
      fi
    elif port_is_free; then
      # Nothing is listening at all - a cold boot, or the origin died. There
      # is no market here to destroy, so bringing one up is purely additive
      # and this is the only path that recovers the demo after a reboot.
      down_polls=$((down_polls + 1))
      log "origin down and port ${ORIGIN_PORT} free (${down_polls}/${EMPTY_STRIKES})"
      if [ "$down_polls" -ge "$EMPTY_STRIKES" ]; then
        cycle
        down_polls=0
        settled_since=""
      fi
    else
      # Something holds the port but is not answering: mid-restart, or wedged.
      # It may still have live positions in memory. Wait it out.
      log "origin not answering but port ${ORIGIN_PORT} is held - waiting"
      down_polls=0
      empty_polls=0
    fi
    sleep "$POLL_SECONDS"
    continue
  fi

  empty_polls=0
  status="$(market_status "$premiere")"

  case "$status" in
    settled|void)
      now="$(date +%s)"
      if [ -z "$settled_since" ]; then
        settled_since="$now"
        log "premiere ${premiere} is '${status}' - replacing in ${GRACE_SECONDS}s"
      elif [ "$((now - settled_since))" -ge "$GRACE_SECONDS" ]; then
        cycle
        settled_since=""
      fi
      ;;
    "")
      # Transport failure, not a finished match.
      log "status unreadable for ${premiere} - holding"
      ;;
    *)
      # open, scheduled, or anything this script has not been taught about.
      # Leave it alone: an unrecognised status is never grounds for deletion.
      if [ -n "$settled_since" ]; then
        log "premiere ${premiere} back to '${status}' - cancelling replacement"
        settled_since=""
      fi
      ;;
  esac

  sleep "$POLL_SECONDS"
done
