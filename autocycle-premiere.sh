#!/usr/bin/env bash
# Keep https://bet.proxywar.xyz/bet showing a tradeable market, indefinitely.
#
#   ./autocycle-premiere.sh
#
# Watches the premiere that /bet currently resolves to. When it settles - or
# when nothing is registered at all - waits out a grace window so late arrivals
# can still read the settlement card, then runs cycle-premiere.sh to put a
# fresh match up.
#
# Without this, the demo URL is only tradeable for the ~12 minutes of whatever
# match was admitted last, and shows a settled market forever afterwards.
#
# Run it under a supervisor. It is a plain loop: it holds no state beyond the
# current premiere id, and is safe to kill and restart at any point.
set -uo pipefail

ORIGIN="https://bet.proxywar.xyz"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Seconds to leave a settled market up before replacing it, so someone who
# arrives just after the finish still sees who won and what they were paid.
GRACE_SECONDS="${AUTOCYCLE_GRACE_SECONDS:-240}"
POLL_SECONDS="${AUTOCYCLE_POLL_SECONDS:-20}"
LEAD_MIN="${AUTOCYCLE_LEAD_MIN:-3}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

current_premiere() {
  curl -s -o /dev/null -w '%{redirect_url}' -m 20 "${ORIGIN}/bet" 2>/dev/null \
    | sed 's|.*/bet/||'
}

market_status() {
  curl -s -m 20 "${ORIGIN}/api/premieres/$1/market" 2>/dev/null \
    | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["market"]["status"])
except Exception: print("unknown")' 2>/dev/null
}

cycle() {
  log "cycling onto a fresh match"
  if (cd "$HERE" && ./cycle-premiere.sh "$LEAD_MIN" >/tmp/pw-bet-autocycle-run.log 2>&1); then
    log "up: $(current_premiere)"
  else
    # Most likely the origin could not be restarted, or admission failed. Say
    # so and back off rather than hammering a broken deploy.
    log "!! cycle FAILED - see /tmp/pw-bet-autocycle-run.log"
    sleep 120
  fi
}

log "watching ${ORIGIN}/bet (grace ${GRACE_SECONDS}s, lead ${LEAD_MIN}m)"
settled_since=""

while true; do
  premiere="$(current_premiere)"

  if [ -z "$premiere" ]; then
    log "nothing registered"
    cycle
    settled_since=""
    sleep "$POLL_SECONDS"
    continue
  fi

  status="$(market_status "$premiere")"

  case "$status" in
    open)
      # Healthy and tradeable. Reset any settlement timer we were holding.
      if [ -n "$settled_since" ]; then settled_since=""; fi
      ;;
    unknown)
      # A restart or a transient blip. Don't treat it as a finished match.
      log "status unreadable for ${premiere}"
      ;;
    *)
      # settled, void, or anything else terminal.
      now="$(date +%s)"
      if [ -z "$settled_since" ]; then
        settled_since="$now"
        log "premiere ${premiere} is '${status}' - replacing in ${GRACE_SECONDS}s"
      elif [ "$((now - settled_since))" -ge "$GRACE_SECONDS" ]; then
        cycle
        settled_since=""
      fi
      ;;
  esac

  sleep "$POLL_SECONDS"
done
