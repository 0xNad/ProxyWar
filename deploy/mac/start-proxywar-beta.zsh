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
# A disabled verification probe exercises the exact installed attestation path
# while the highest-priority deny remains latched. It never enables a Clip gate.
CLIPS_VERIFY_ATTESTATION_ONLY="${PROXYWAR_CLIPS_VERIFY_ATTESTATION_ONLY:-false}"
CLIPS_EXPECTED_COMMIT="${PROXYWAR_CLIPS_EXPECTED_COMMIT:-}"
CLIPS_EXPECTED_TREE="${PROXYWAR_CLIPS_EXPECTED_TREE:-}"
CLIPS_EXPECTED_BUILD_SHA256="${PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256:-}"
CLIPS_EXPECTED_ATTESTATION_NONCE="${PROXYWAR_CLIPS_EXPECTED_ATTESTATION_NONCE:-}"
# launchd cannot traverse a release checkout under Documents with Git because
# macOS privacy policy applies to the noninteractive zsh/git processes. The
# reviewed wrapper instead binds an installed helper outside Documents. That
# helper verifies an owner-only deployment attestation and every attested file
# with Node, the same executable class that runs the server.
CLIPS_WRAPPER_PATH="${0:A}"
CLIPS_WRAPPER_DIR="${CLIPS_WRAPPER_PATH:h}"
CLIPS_TRUSTED_ROOT="${CLIPS_WRAPPER_DIR:h}"
CLIPS_DEPLOYMENT_ATTESTATION_HELPER="$CLIPS_WRAPPER_DIR/proxywar-clips-deployment-attestation.mjs"
CLIPS_DEPLOYMENT_ATTESTATION_HELPER_SHA256="7e4aaffe26de13034d1680caf02397f4c5f73ebda766aff214dde7c6e3614cd7"

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
  CLIPS_STATE_ROOT="$PROXYWAR_REPLAY_PREMIERE_STATE_ROOT"
else
  CLIPS_STATE_ROOT="$HOME/Library/Application Support/ProxyWar/storage/replay-premiere"
fi
NODE_BIN="${PROXYWAR_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  echo "ProxyWar beta Node executable is unavailable or not absolute: $NODE_BIN" >&2
  exit 69
fi

CLIPS_CONFIGURATION_BLOCKED=false
CLIPS_DURABLY_DISABLED=false
CLIPS_ACTIVATION_SOURCE=none
CLIPS_DEPLOYMENT_ATTESTATION_HELPER_VERIFIED=false
if [[ "$CLIPS_FORCE_DISABLED" != "true" || "$CLIPS_VERIFY_ATTESTATION_ONLY" == "true" ]]; then
  CLIPS_DEPLOYMENT_ATTESTATION_HELPER_HASH_OUTPUT="$(/usr/bin/shasum -a 256 "$CLIPS_DEPLOYMENT_ATTESTATION_HELPER" 2> /dev/null || true)"
  CLIPS_DEPLOYMENT_ATTESTATION_HELPER_CURRENT_SHA256="${CLIPS_DEPLOYMENT_ATTESTATION_HELPER_HASH_OUTPUT%% *}"
  if [[ "$CLIPS_DEPLOYMENT_ATTESTATION_HELPER_CURRENT_SHA256" != "$CLIPS_DEPLOYMENT_ATTESTATION_HELPER_SHA256" ]]; then
    echo "Clip deployment attestation helper verification failed; Clips disabled" >&2
    CLIPS_CONFIGURATION_BLOCKED=true
  else
    CLIPS_DEPLOYMENT_ATTESTATION_HELPER_VERIFIED=true
  fi
fi
if [[ "$CLIPS_FORCE_DISABLED" != "true" && "$CLIPS_RELEASE_OVERRIDE" != "true" && "$CLIPS_DEPLOYMENT_ATTESTATION_HELPER_VERIFIED" == "true" ]]; then
  CLIPS_RELEASE_STATE_STATUS="$("$NODE_BIN" "$CLIPS_DEPLOYMENT_ATTESTATION_HELPER" release-status --state-root="$CLIPS_STATE_ROOT" --trusted-root="$CLIPS_TRUSTED_ROOT" 2> /dev/null || true)"
  if [[ "$CLIPS_RELEASE_STATE_STATUS" == "disabled" ]]; then
    CLIPS_DURABLY_DISABLED=true
  elif [[ "$CLIPS_RELEASE_STATE_STATUS" == enabled\ * ]]; then
    read -r CLIPS_RELEASE_STATE_KIND CLIPS_EXPECTED_COMMIT CLIPS_EXPECTED_TREE CLIPS_EXPECTED_BUILD_SHA256 CLIPS_EXPECTED_ATTESTATION_NONCE CLIPS_RELEASE_STATE_EXTRA <<< "$CLIPS_RELEASE_STATE_STATUS"
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
if [[ "$CLIPS_VERIFY_ATTESTATION_ONLY" == "true" && ("$CLIPS_FORCE_DISABLED" != "true" || "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true" || "$CLIPS_RELEASE_OVERRIDE" == "true") ]]; then
  echo "Clip deployment attestation probe requires force-disabled with activation overrides unset; Clips disabled" >&2
  CLIPS_CONFIGURATION_BLOCKED=true
fi
if [[ "$CLIPS_FORCE_DISABLED" != "true" && "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true" && "$CLIPS_RELEASE_OVERRIDE" == "true" ]]; then
  echo "Clip canary and release overrides cannot be enabled together" >&2
  CLIPS_CONFIGURATION_BLOCKED=true
fi
if [[ ("$CLIPS_VERIFY_ATTESTATION_ONLY" == "true" || "$CLIPS_FORCE_DISABLED" != "true" && ("$CLIPS_RELEASE_OVERRIDE" == "true" || "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true")) && "$CLIPS_CONFIGURATION_BLOCKED" != "true" ]]; then
  if [[ ${#CLIPS_EXPECTED_COMMIT} -ne 40 || "$CLIPS_EXPECTED_COMMIT" == *[^a-f0-9]* || ${#CLIPS_EXPECTED_TREE} -ne 40 || "$CLIPS_EXPECTED_TREE" == *[^a-f0-9]* || ${#CLIPS_EXPECTED_BUILD_SHA256} -ne 64 || "$CLIPS_EXPECTED_BUILD_SHA256" == *[^a-f0-9]* || ${#CLIPS_EXPECTED_ATTESTATION_NONCE} -ne 64 || "$CLIPS_EXPECTED_ATTESTATION_NONCE" == *[^a-f0-9]* ]]; then
    echo "Clip activation requires exact commit, tree, build, and attestation bindings; Clips disabled" >&2
    CLIPS_CONFIGURATION_BLOCKED=true
  fi
  if [[ "$CLIPS_CONFIGURATION_BLOCKED" != "true" ]]; then
    if [[ "$CLIPS_DEPLOYMENT_ATTESTATION_HELPER_VERIFIED" == "true" ]]; then
      CLIPS_DEPLOYMENT_ATTESTATION_STATUS="$("$NODE_BIN" "$CLIPS_DEPLOYMENT_ATTESTATION_HELPER" verify \
        --state-root="$CLIPS_STATE_ROOT" \
        --trusted-root="$CLIPS_TRUSTED_ROOT" \
        --project-dir="$PROJECT_DIR" \
        --wrapper-path="$CLIPS_WRAPPER_PATH" \
        --helper-path="$CLIPS_DEPLOYMENT_ATTESTATION_HELPER" \
        --expected-nonce="$CLIPS_EXPECTED_ATTESTATION_NONCE" \
        --expected-commit="$CLIPS_EXPECTED_COMMIT" \
        --expected-tree="$CLIPS_EXPECTED_TREE" \
        --expected-build-sha256="$CLIPS_EXPECTED_BUILD_SHA256" \
        2> /dev/null || true)"
      if [[ "$CLIPS_DEPLOYMENT_ATTESTATION_STATUS" != "verified" ]]; then
        case "$CLIPS_DEPLOYMENT_ATTESTATION_STATUS" in
          "failed root") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="root" ;;
          "failed attestation") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="record" ;;
          "failed binding") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="binding" ;;
          "failed wrapper") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="wrapper" ;;
          "failed helper") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="helper" ;;
          "failed tracked_content") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="tracked content" ;;
          "failed runtime_inventory") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="runtime inventory" ;;
          "failed static_build") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="static build" ;;
          *) CLIPS_DEPLOYMENT_ATTESTATION_STAGE="invocation" ;;
        esac
        echo "Clip deployment attestation $CLIPS_DEPLOYMENT_ATTESTATION_STAGE verification failed; Clips disabled" >&2
        CLIPS_CONFIGURATION_BLOCKED=true
      elif [[ "$CLIPS_VERIFY_ATTESTATION_ONLY" == "true" ]]; then
        echo "Clip deployment attestation verification passed" >&2
      fi
    else
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
unset CLIPS_VERIFY_ATTESTATION_ONLY
unset PROXYWAR_CLIPS_VERIFY_ATTESTATION_ONLY
unset CLIPS_EXPECTED_COMMIT
unset PROXYWAR_CLIPS_EXPECTED_COMMIT
unset CLIPS_EXPECTED_TREE
unset PROXYWAR_CLIPS_EXPECTED_TREE
unset CLIPS_EXPECTED_BUILD_SHA256
unset PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
unset CLIPS_EXPECTED_ATTESTATION_NONCE
unset PROXYWAR_CLIPS_EXPECTED_ATTESTATION_NONCE
unset CLIPS_WRAPPER_PATH
unset CLIPS_WRAPPER_DIR
unset CLIPS_TRUSTED_ROOT
unset CLIPS_DEPLOYMENT_ATTESTATION_HELPER
unset CLIPS_DEPLOYMENT_ATTESTATION_HELPER_SHA256
unset CLIPS_DEPLOYMENT_ATTESTATION_HELPER_HASH_OUTPUT
unset CLIPS_DEPLOYMENT_ATTESTATION_HELPER_CURRENT_SHA256
unset CLIPS_DEPLOYMENT_ATTESTATION_HELPER_VERIFIED
unset CLIPS_DEPLOYMENT_ATTESTATION_STATUS
unset CLIPS_DEPLOYMENT_ATTESTATION_STAGE
unset CLIPS_STATE_ROOT
unset CLIPS_RELEASE_STATE_STATUS
unset CLIPS_RELEASE_STATE_KIND
unset CLIPS_RELEASE_STATE_EXTRA
unset CLIPS_CONFIGURATION_BLOCKED
unset CLIPS_DURABLY_DISABLED
unset CLIPS_ACTIVATION_SOURCE

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
