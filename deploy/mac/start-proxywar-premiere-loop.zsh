#!/bin/zsh
set -euo pipefail

# One premiere-loop iteration. Launched by com.proxywar.premiere-loop.plist on a
# StartInterval, this sources the same env file as the beta server (so
# PROXYWAR_PUBLIC_URL, PROXYWAR_ARTIFACTS_ROOT, AI_LEAGUE_DEMO_PORT, and
# PROXYWAR_LEAGUE_RETENTION_PINS match the running server and the league mirror),
# does a storage-floor preflight, then runs the loop once and exits.
#
# Pass --shadow (PROXYWAR_PREMIERE_LOOP_SHADOW=true) for safe live observation:
# the loop then INGESTS only and performs no contract write, pin, admission, or
# restart.

PROJECT_DIR="${PROXYWAR_PROJECT_DIR:-$HOME/Documents/ProxyWar}"
ENV_FILE="${PROXYWAR_ENV_FILE:-$HOME/.proxywar/proxywar-beta.env}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "ProxyWar project directory not found: $PROJECT_DIR" >&2
  exit 64
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ProxyWar env file not found: $ENV_FILE" >&2
  exit 64
fi

set -a
source "$ENV_FILE"
set +a

cd "$PROJECT_DIR"

# This wrapper bypasses the package script's `cross-env GAME_ENV=dev` so
# launchd can supervise the direct Node process. Preserve the same required
# bundled-game environment explicitly; without it checkpoint projection fails
# before an otherwise valid completed replay can be admitted.
export GAME_ENV=dev

# Storage-floor preflight (defaults to 10 GiB, matching the league mirror). Skip
# the tick cheaply rather than starting downloads under disk pressure; the loop
# itself also re-checks the floor before each fetch.
MIN_FREE_GIB="${PROXYWAR_LEAGUE_MIN_FREE_GIB:-10}"
FREE_KB="$(df -k "$PROJECT_DIR" | awk 'NR==2 {print $4}')"
FREE_GIB=$((FREE_KB / 1024 / 1024))
if ((FREE_GIB < MIN_FREE_GIB)); then
  echo "premiere-loop skipped: ${FREE_GIB} GiB free < ${MIN_FREE_GIB} GiB floor" >&2
  exit 0
fi

NODE_BIN="${PROXYWAR_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  echo "ProxyWar premiere-loop Node executable is unavailable or not absolute: $NODE_BIN" >&2
  exit 69
fi

LOOP_ARGS=()
if [[ "${PROXYWAR_PREMIERE_LOOP_SHADOW:-false}" == "true" ]]; then
  LOOP_ARGS+=("--shadow")
fi

exec "$NODE_BIN" --import tsx src/scripts/replay-premiere-loop.ts "${LOOP_ARGS[@]}"
