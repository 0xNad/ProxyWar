#!/bin/zsh
set -euo pipefail

# The Frontier Four scheduler: an endless 4x3 team competition between four
# frontier models on the Frontier Four coworld, feeding /world. Launched by
# com.proxywar.frontier-four.plist (KeepAlive); the scheduler loops for ever.
#
# Python runs from a HOME copy with its working directory in HOME and never
# touches the external volumes. On a Mac the interpreter needs a
# removable-volume grant for that, which a background job cannot obtain: the
# permission prompt it raises stays unanswered, and while it is pending every
# launchd job's volume access on the host blocks. Publishing the games to
# /world is therefore a separate zsh job
# (start-proxywar-frontier-four-publisher.zsh) and the scheduler config keeps
# "publish": null. See docs/PROXYWAR_FRONTIER_FOUR.md.

PROJECT_DIR="${PROXYWAR_PROJECT_DIR:-$HOME/Documents/ProxyWar}"
STATE_HOME="${PROXYWAR_FRONTIER_FOUR_HOME:-$HOME/Library/Application Support/ProxyWar/frontier-four}"
CONFIG="${PROXYWAR_FRONTIER_FOUR_CONFIG:-$STATE_HOME/frontier-four.json}"
VENV="${PROXYWAR_FRONTIER_FOUR_VENV:-$STATE_HOME/venv}"
SOURCE="$PROJECT_DIR/coworld-adapter/frontier-four/scheduler.py"

if [[ ! -f "$SOURCE" ]]; then
  echo "scheduler not found under $PROJECT_DIR (deploy the Frontier Four first)" >&2
  sleep 300
  exit 64
fi
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "virtual environment missing: $VENV (uv venv, then uv pip install coworld==<pinned>)" >&2
  sleep 300
  exit 64
fi

mkdir -p "$STATE_HOME/bin"
cp "$SOURCE" "$STATE_HOME/bin/scheduler.py"
cd "$STATE_HOME/bin"
exec "$VENV/bin/python" scheduler.py --config "$CONFIG" --interval 60
