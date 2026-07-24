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
# The release override is an explicit launchd-manager control. It is captured
# before the private env is sourced so Clips can be enabled without reading or
# rewriting that file. Unlike the one-shot canary, it enables the retained
# league-replay surface and remains effective across managed restarts until
# unset. The live-Premiere generation lane stays independently disabled.
CLIPS_RELEASE_OVERRIDE="${PROXYWAR_CLIPS_RELEASE_OVERRIDE:-false}"
# This manager-only deny gate is captured before the private env is sourced and
# has higher priority than canary, release-manager, and durable-state enables.
# It keeps the core league available when a durable-state write is impossible.
CLIPS_FORCE_DISABLED="${PROXYWAR_CLIPS_FORCE_DISABLED:-false}"
CLIPS_EXPECTED_COMMIT="${PROXYWAR_CLIPS_EXPECTED_COMMIT:-}"
CLIPS_EXPECTED_TREE="${PROXYWAR_CLIPS_EXPECTED_TREE:-}"
CLIPS_EXPECTED_BUILD_SHA256="${PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256:-}"
# Resolve Git against launchd's reviewed environment before the private env is
# sourced. That file may replace PATH for the server process; Clip identity
# verification must keep using the absolute executable and helper search path
# that launchd supplied rather than re-resolving a bare `git` afterward.
CLIPS_GIT_BIN="$(command -v git || true)"
CLIPS_GIT_PATH="$PATH"

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

if [[ -n "${PROXYWAR_REPLAY_PREMIERE_STATE_ROOT:-}" ]]; then
  CLIPS_RELEASE_STATE_FILE="$PROXYWAR_REPLAY_PREMIERE_STATE_ROOT/clip-release-v1.json"
else
  CLIPS_RELEASE_STATE_FILE="$HOME/Library/Application Support/ProxyWar/storage/replay-premiere/clip-release-v1.json"
fi
NODE_BIN="${PROXYWAR_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  echo "ProxyWar beta Node executable is unavailable or not absolute: $NODE_BIN" >&2
  exit 69
fi

CLIPS_CONFIGURATION_BLOCKED=false
CLIPS_DURABLY_DISABLED=false
CLIPS_ACTIVATION_SOURCE=none
if [[ "$CLIPS_FORCE_DISABLED" != "true" && "$CLIPS_RELEASE_OVERRIDE" != "true" && -e "$CLIPS_RELEASE_STATE_FILE" ]]; then
  CLIPS_RELEASE_STATE_STATUS="$("$NODE_BIN" "$PROJECT_DIR/deploy/mac/proxywar-clips-release-state.mjs" status --path="$CLIPS_RELEASE_STATE_FILE" --shell=true 2> /dev/null || true)"
  if [[ "$CLIPS_RELEASE_STATE_STATUS" == "disabled" ]]; then
    CLIPS_DURABLY_DISABLED=true
  elif [[ "$CLIPS_RELEASE_STATE_STATUS" == enabled\ * ]]; then
    read -r CLIPS_RELEASE_STATE_KIND CLIPS_EXPECTED_COMMIT CLIPS_EXPECTED_TREE CLIPS_EXPECTED_BUILD_SHA256 CLIPS_RELEASE_STATE_EXTRA <<< "$CLIPS_RELEASE_STATE_STATUS"
    if [[ "$CLIPS_RELEASE_STATE_KIND" != "enabled" || -n "$CLIPS_RELEASE_STATE_EXTRA" ]]; then
      echo "Clip durable release state is malformed; Clips disabled" >&2
      CLIPS_CONFIGURATION_BLOCKED=true
    else
      CLIPS_RELEASE_OVERRIDE=true
      CLIPS_ACTIVATION_SOURCE=durable_state
    fi
  else
    echo "Clip durable release state is unsafe or malformed; Clips disabled" >&2
    CLIPS_CONFIGURATION_BLOCKED=true
  fi
fi
if [[ "$CLIPS_FORCE_DISABLED" != "true" && "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true" && "$CLIPS_RELEASE_OVERRIDE" == "true" ]]; then
  echo "Clip canary and release overrides cannot be enabled together" >&2
  CLIPS_CONFIGURATION_BLOCKED=true
fi
if [[ "$CLIPS_FORCE_DISABLED" != "true" && ("$CLIPS_RELEASE_OVERRIDE" == "true" || "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true") && "$CLIPS_CONFIGURATION_BLOCKED" != "true" ]]; then
  if [[ ${#CLIPS_EXPECTED_COMMIT} -ne 40 || "$CLIPS_EXPECTED_COMMIT" == *[^a-f0-9]* || ${#CLIPS_EXPECTED_TREE} -ne 40 || "$CLIPS_EXPECTED_TREE" == *[^a-f0-9]* || ${#CLIPS_EXPECTED_BUILD_SHA256} -ne 64 || "$CLIPS_EXPECTED_BUILD_SHA256" == *[^a-f0-9]* ]]; then
    echo "Clip activation requires exact commit, tree, and build bindings; Clips disabled" >&2
    CLIPS_CONFIGURATION_BLOCKED=true
  fi
  if [[ "$CLIPS_CONFIGURATION_BLOCKED" != "true" ]]; then
    CURRENT_RELEASE_COMMIT=""
    CURRENT_RELEASE_TREE=""
    CURRENT_RELEASE_STATUS=""
    CURRENT_RELEASE_BUILD_SHA256=""
    if [[ -z "$CLIPS_GIT_BIN" || "$CLIPS_GIT_BIN" != /* || ! -x "$CLIPS_GIT_BIN" ]] \
      || ! CURRENT_RELEASE_COMMIT="$(PATH="$CLIPS_GIT_PATH" "$CLIPS_GIT_BIN" -C "$PROJECT_DIR" rev-parse HEAD 2> /dev/null)" \
      || ! CURRENT_RELEASE_TREE="$(PATH="$CLIPS_GIT_PATH" "$CLIPS_GIT_BIN" -C "$PROJECT_DIR" rev-parse 'HEAD^{tree}' 2> /dev/null)" \
      || ! CURRENT_RELEASE_STATUS="$(PATH="$CLIPS_GIT_PATH" "$CLIPS_GIT_BIN" -C "$PROJECT_DIR" status --porcelain --untracked-files=all 2> /dev/null)" \
      || ! CURRENT_RELEASE_BUILD_SHA256="$("$NODE_BIN" "$PROJECT_DIR/deploy/mac/proxywar-clips-release-state.mjs" build-hash --path="$PROJECT_DIR/static" 2> /dev/null)"; then
      echo "Clip activation could not verify the deployed commit, tree, status, and build; Clips disabled" >&2
      CLIPS_CONFIGURATION_BLOCKED=true
    elif [[ "$CURRENT_RELEASE_COMMIT" != "$CLIPS_EXPECTED_COMMIT" || "$CURRENT_RELEASE_TREE" != "$CLIPS_EXPECTED_TREE" || -n "$CURRENT_RELEASE_STATUS" || "$CURRENT_RELEASE_BUILD_SHA256" != "$CLIPS_EXPECTED_BUILD_SHA256" ]]; then
      echo "Clip activation does not match the clean deployed commit, tree, and build; Clips disabled" >&2
      CLIPS_CONFIGURATION_BLOCKED=true
    fi
  fi
fi
if [[ "$CLIPS_FORCE_DISABLED" == "true" ]]; then
  export PROXYWAR_CLIPS_ENABLED=false
  export PROXYWAR_PREMIERE_CLIPS_ENABLED=false
  export PROXYWAR_LEAGUE_CLIPS_ENABLED=false
elif [[ "$CLIPS_CONFIGURATION_BLOCKED" == "true" ]]; then
  export PROXYWAR_CLIPS_ENABLED=false
  export PROXYWAR_PREMIERE_CLIPS_ENABLED=false
  export PROXYWAR_LEAGUE_CLIPS_ENABLED=false
elif [[ "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true" ]]; then
  CLIPS_ACTIVATION_SOURCE=canary_manager
  export PROXYWAR_CLIPS_ENABLED=true
  export PROXYWAR_PREMIERE_CLIPS_ENABLED=false
  export PROXYWAR_LEAGUE_CLIPS_ENABLED=false
elif [[ "$CLIPS_RELEASE_OVERRIDE" == "true" ]]; then
  if [[ "$CLIPS_ACTIVATION_SOURCE" == "none" ]]; then
    CLIPS_ACTIVATION_SOURCE=release_manager
  fi
  export PROXYWAR_CLIPS_ENABLED=true
  export PROXYWAR_PREMIERE_CLIPS_ENABLED=false
  export PROXYWAR_LEAGUE_CLIPS_ENABLED=true
elif [[ "$CLIPS_DURABLY_DISABLED" == "true" ]]; then
  export PROXYWAR_CLIPS_ENABLED=false
  export PROXYWAR_PREMIERE_CLIPS_ENABLED=false
  export PROXYWAR_LEAGUE_CLIPS_ENABLED=false
fi
if [[ "$CLIPS_ACTIVATION_SOURCE" != "none" && "$CLIPS_CONFIGURATION_BLOCKED" != "true" ]]; then
  echo "Clip activation source: $CLIPS_ACTIVATION_SOURCE" >&2
fi
unset ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
unset PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
unset CLIPS_RELEASE_OVERRIDE
unset PROXYWAR_CLIPS_RELEASE_OVERRIDE
unset CLIPS_FORCE_DISABLED
unset PROXYWAR_CLIPS_FORCE_DISABLED
unset CLIPS_EXPECTED_COMMIT
unset PROXYWAR_CLIPS_EXPECTED_COMMIT
unset CLIPS_EXPECTED_TREE
unset PROXYWAR_CLIPS_EXPECTED_TREE
unset CLIPS_EXPECTED_BUILD_SHA256
unset PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
unset CLIPS_GIT_BIN
unset CLIPS_GIT_PATH
unset CLIPS_RELEASE_STATE_FILE
unset CLIPS_RELEASE_STATE_STATUS
unset CLIPS_RELEASE_STATE_KIND
unset CLIPS_RELEASE_STATE_EXTRA
unset CLIPS_CONFIGURATION_BLOCKED
unset CLIPS_DURABLY_DISABLED
unset CLIPS_ACTIVATION_SOURCE
unset CURRENT_RELEASE_COMMIT
unset CURRENT_RELEASE_TREE
unset CURRENT_RELEASE_STATUS
unset CURRENT_RELEASE_BUILD_SHA256

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

# caffeinate execs the utility in its own PID and retains only an assertion
# helper. `node --import tsx` therefore remains launchd's managed process; do
# not reintroduce npm, cross-env, or the spawning tsx CLI here.
exec /usr/bin/caffeinate -s \
  "$NODE_BIN" --import tsx src/scripts/ai-agent-demo-server.ts
