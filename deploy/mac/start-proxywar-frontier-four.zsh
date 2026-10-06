#!/bin/zsh
set -euo pipefail

# The Frontier scheduler, Season 2: two battles a day at fixed UTC times
# between the frontier models on the Frontier FFA coworld, one nation each,
# feeding /world. Launched by com.proxywar.frontier-four.plist (KeepAlive);
# the scheduler loops for ever.
#
# Season 2 keeps its own state directory (frontier-ffa): its config, its
# rotation and spend state, its request records and its games file
# (frontier-ffa-games.jsonl). Season 1's frontier-four directory, games.jsonl
# included, is left as it was; only its virtual environment is reused.
#
# Python runs from a HOME copy with its working directory in HOME and never
# touches the external volumes. On a Mac the interpreter needs a
# removable-volume grant for that, which a background job cannot obtain: the
# permission prompt it raises stays unanswered, and while it is pending every
# launchd job's volume access on the host blocks. Publishing the games to
# /world is therefore a separate zsh job
# (start-proxywar-frontier-four-publisher.zsh), and the scheduler refuses any
# state or games path under /Volumes. See docs/PROXYWAR_FRONTIER_FOUR.md.

PROJECT_DIR="${PROXYWAR_PROJECT_DIR:-$HOME/Documents/ProxyWar}"
SEASON_HOME="${PROXYWAR_FRONTIER_FFA_HOME:-$HOME/Library/Application Support/ProxyWar/frontier-ffa}"
CONFIG="${PROXYWAR_FRONTIER_FFA_CONFIG:-$SEASON_HOME/frontier-ffa.json}"
VENV="${PROXYWAR_FRONTIER_VENV:-$SEASON_HOME/venv}"
if [[ -z "${PROXYWAR_FRONTIER_VENV:-}" && ! -x "$VENV/bin/python" ]]; then
  VENV="$HOME/Library/Application Support/ProxyWar/frontier-four/venv"
fi
SOURCE="$PROJECT_DIR/coworld-adapter/frontier-four/scheduler.py"

if [[ ! -f "$SOURCE" ]]; then
  echo "scheduler not found under $PROJECT_DIR (deploy the Frontier scheduler first)" >&2
  sleep 300
  exit 64
fi
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "virtual environment missing: $VENV (uv venv, then uv pip install coworld==<pinned>)" >&2
  sleep 300
  exit 64
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "config missing: $CONFIG (copy coworld-adapter/frontier-four/frontier-ffa.example.json and fill in the ids)" >&2
  sleep 300
  exit 64
fi

mkdir -p "$SEASON_HOME/bin"
cp "$SOURCE" "$SEASON_HOME/bin/scheduler.py"
cd "$SEASON_HOME/bin"
exec "$VENV/bin/python" scheduler.py --config "$CONFIG" --interval 60
