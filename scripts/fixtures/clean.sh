#!/usr/bin/env bash
# Stops every `pw-fixture-origin-<port>` process this repo's fixture tooling
# left behind via a stale pidfile, then removes the pidfile (and its
# matching logfile) either way. Only ever acts on pidfile-tracked
# processes — never a bare port scan or process-name match — so it can
# never touch a process this tooling didn't itself start.
#
# `run-public-product-fixtures.sh`'s own `stop_origin` already cleans up
# after a normal run; this exists for the runs that DIDN'T get a clean
# stop — a killed test process, an interrupted fixture boot, or a crashed
# vitest worker (`tests/e2e/support/FixtureServer.ts`'s
# `startFixtureServerWithLivePremiere` previously looked for the legacy,
# non-port-scoped `/tmp/pw-fixture-origin.pid`, so it silently never found
# its own pidfile and never stopped its origin — fixed alongside this
# script, but old runs may still have left pidfiles around).
set -euo pipefail

found=0
stopped=0

clean_one() {
  local pidfile="$1"
  local port="$2"
  found=$((found + 1))
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "stopping pw-fixture-origin-${port} (pid $pid)"
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
    stopped=$((stopped + 1))
  fi
  rm -f "$pidfile" "/tmp/pw-fixture-origin-${port}.log"
}

for pidfile in /tmp/pw-fixture-origin-*.pid; do
  [ -e "$pidfile" ] || continue
  port="$(basename "$pidfile" .pid)"
  port="${port#pw-fixture-origin-}"
  clean_one "$pidfile" "$port"
done

# Legacy, pre-port-scoping pidfile — see the doc comment above.
if [ -e "/tmp/pw-fixture-origin.pid" ]; then
  found=$((found + 1))
  pid="$(cat "/tmp/pw-fixture-origin.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "stopping legacy pw-fixture-origin (pid $pid)"
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
    stopped=$((stopped + 1))
  fi
  rm -f "/tmp/pw-fixture-origin.pid" "/tmp/pw-fixture-origin.log"
fi

if [ "$found" -eq 0 ]; then
  echo "no stale pw-fixture-origin pidfiles found"
else
  echo "cleaned $found pidfile(s), stopped $stopped live process(es)"
fi
