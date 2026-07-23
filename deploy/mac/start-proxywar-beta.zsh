#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${PROXYWAR_PROJECT_DIR:-$HOME/Documents/ProxyWar}"
ENV_FILE="${PROXYWAR_ENV_FILE:-$HOME/.proxywar/proxywar-beta.env}"
# The archived-replay Clip canary uses a bounded launchd-manager override so
# the master gate can be enabled for one reviewed restart without editing the
# private env file. The ordinary Premiere/league flags remain independent and
# must stay false. Capture before sourcing because the private env intentionally
# keeps the master gate false outside the canary.
ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE="${PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE:-false}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "ProxyWar project directory not found: $PROJECT_DIR" >&2
  exit 64
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ProxyWar beta env file not found: $ENV_FILE" >&2
  echo "Copy deploy/mac/proxywar-beta.env.example to that path and fill the real values." >&2
  exit 64
fi

set -a
source "$ENV_FILE"
set +a

if [[ "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true" ]]; then
  export PROXYWAR_CLIPS_ENABLED=true
fi
unset ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
unset PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE

cd "$PROJECT_DIR"

# Keep launchd attached to the server that owns the writer lock. Running this
# through npm -> cross-env -> tsx leaves launchd supervising an ancestor; an
# operator restart can then kill npm while the actual server survives as an
# orphan and rejects the replacement with writer_already_active_on_host.
export NODE_ENV=production
export GAME_ENV=dev
export PROXYWAR_BETA_ENABLED=true
export PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS=false
export PROXYWAR_MAX_QUEUED_JOBS=1
export PROXYWAR_AGENT_RELAY_REDELIVERY_MS=5000
export PROXYWAR_HOUSE_AGENT_BRAIN=planner-claude-cli
export AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS=true
export AI_LEAGUE_CLAUDE_TIMEOUT_MS=60000

NODE_BIN="${PROXYWAR_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  echo "ProxyWar beta Node executable is unavailable or not absolute: $NODE_BIN" >&2
  exit 69
fi

# caffeinate execs the utility in its own PID and retains only an assertion
# helper. `node --import tsx` therefore remains launchd's managed process; do
# not reintroduce npm, cross-env, or the spawning tsx CLI here.
exec /usr/bin/caffeinate -s \
  "$NODE_BIN" --import tsx src/scripts/ai-agent-demo-server.ts
