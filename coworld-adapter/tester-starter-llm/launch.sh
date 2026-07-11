#!/usr/bin/env bash
#
# ProxyWar agent starter — checks your setup, signs you in, builds your agent,
# uploads it to Softmax (Bedrock-powered), and prints the policy id you send to
# whoever's running the match.
#
# Usage:
#   bash launch.sh [agent-name] [--yes] [--doctor]
#
#   agent-name   name for your uploaded policy (default: my-proxywar-agent)
#   --yes        auto-approve safe setup steps (installing uv, starting Docker);
#                for coding agents / CI, PROXYWAR_STARTER_YES=1 works too
#   --doctor     only check the environment and report; change nothing
#
# The script fixes or guides every gap it finds; the one thing it can't do for
# you is the Softmax sign-in (runs in your browser, once). No model API key is
# needed — the agent uses Softmax's in-cluster Bedrock (--use-bedrock).
#
set -euo pipefail

NAME="my-proxywar-agent"
YES="${PROXYWAR_STARTER_YES:-0}"
DOCTOR=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --doctor|--check) DOCTOR=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: bash launch.sh [agent-name] [--yes] [--doctor]

  agent-name   name for your uploaded policy (default: my-proxywar-agent)
  --yes        auto-approve safe setup steps (installing uv, starting Docker);
               for coding agents / CI, PROXYWAR_STARTER_YES=1 works too
  --doctor     only check the environment and report; change nothing
EOF
      exit 0 ;;
    -*) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
    *) NAME="$arg" ;;
  esac
done

IMAGE="proxywar-agent-llm:latest"
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="https://softmax.com/api"
BLOCKED=0
AUTH="unknown"

ok()    { printf '  [ok]    %s\n' "$*"; }
fixed() { printf '  [fixed] %s\n' "$*"; }
note()  { printf '  [--]    %s\n' "$*"; }
needs() { printf '  [needs] %s\n' "$*"; BLOCKED=1; }

confirm() { # confirm "question" -> yes/no; --yes auto-approves; non-interactive declines
  if [ "$YES" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then
    note "non-interactive shell — re-run with --yes to auto-approve this"
    return 1
  fi
  printf '%s [Y/n] ' "$1"
  read -r reply || return 1
  case "$reply" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
}

echo "==> Checking your setup..."

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux)  OS=linux ;;
  *) echo "This starter supports macOS and Linux (on Windows, use WSL)." >&2; exit 1 ;;
esac

# uv — user-space install, no sudo
if command -v uv >/dev/null 2>&1; then
  ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"
elif [ "$DOCTOR" = "1" ]; then
  note "uv missing — launch will offer to install it (user-space, no sudo)"
elif confirm "uv is missing — install it now? (official installer, no sudo)"; then
  if curl -LsSf https://astral.sh/uv/install.sh | sh; then
    export PATH="$HOME/.local/bin:$PATH"
    if command -v uv >/dev/null 2>&1; then
      fixed "uv $(uv --version | awk '{print $2}')"
    else
      needs "uv installed but not on PATH yet — open a new terminal and re-run"
    fi
  else
    needs "uv install failed — see https://docs.astral.sh/uv/ then re-run"
  fi
else
  needs "uv — install: curl -LsSf https://astral.sh/uv/install.sh | sh"
fi

# Docker — detect and guide; auto-start on macOS with consent (never installed for you)
if ! command -v docker >/dev/null 2>&1; then
  needs "Docker — install it, then re-run: https://docs.docker.com/get-docker/"
elif docker info >/dev/null 2>&1; then
  ok "Docker (running)"
elif [ "$OS" = "mac" ] && [ -d "/Applications/Docker.app" ]; then
  if [ "$DOCTOR" = "1" ]; then
    note "Docker installed but not running — launch will offer to start it"
  elif confirm "Docker is installed but not running — start Docker Desktop now?"; then
    open -a Docker
    printf '  starting Docker'
    STARTED=0
    for _ in $(seq 1 30); do
      if docker info >/dev/null 2>&1; then STARTED=1; break; fi
      printf '.'
      sleep 3
    done
    echo
    if [ "$STARTED" = "1" ]; then
      fixed "Docker (running)"
    else
      needs "Docker didn't come up in 90s — start Docker Desktop manually, then re-run"
    fi
  else
    needs "Docker daemon — start Docker Desktop, then re-run"
  fi
else
  needs "Docker daemon not running — start it (macOS: Docker Desktop / your runtime; Linux: sudo systemctl start docker), then re-run"
fi

# Softmax sign-in — probe only; the actual login runs after all checks pass
if command -v uv >/dev/null 2>&1; then
  AUTH="$(uvx --from coworld python - "$SERVER" 2>/dev/null <<'PY' || true
import sys
try:
    from coworld.api_client import CoworldApiClient
    with CoworldApiClient.from_login(server_url=sys.argv[1]) as client:
        client.lookup_policy_version(name="proxywar-auth-probe")
    print("ok")
except Exception:
    print("no")
PY
)"
  AUTH="$(printf '%s' "$AUTH" | tail -n1)"
  if [ "$AUTH" = "ok" ]; then
    ok "Softmax sign-in"
  else
    note "not signed in to Softmax — the browser sign-in runs after these checks (free account)"
  fi
else
  note "Softmax sign-in — can't check until uv exists (launch handles both)"
fi

if [ "$DOCTOR" = "1" ]; then
  echo
  if [ "$BLOCKED" = "1" ]; then
    echo "Doctor: fix the [needs] items above, then run: bash launch.sh $NAME"
    exit 1
  fi
  echo "Doctor: ready — run: bash launch.sh $NAME"
  exit 0
fi

if [ "$BLOCKED" = "1" ]; then
  echo
  echo "Fix the [needs] items above, then re-run: bash launch.sh $NAME"
  exit 1
fi

if [ "$AUTH" != "ok" ]; then
  echo "==> Signing in to Softmax (browser sign-in; free account)..."
  uvx --from softmax-cli softmax login
  fixed "Softmax sign-in"
fi

echo "==> Building your agent image (linux/amd64)..."
docker build --platform linux/amd64 -t "$IMAGE" "$HERE"

echo "==> Uploading to Softmax as policy '$NAME' (Bedrock enabled)..."
uvx --from coworld coworld upload-policy "$IMAGE" \
  --name "$NAME" --use-bedrock --run node --run /app/llm-player.mjs

echo "==> Resolving your policy id..."
POLICY_ID="$(uvx --from coworld python - "$NAME" "$SERVER" <<'PY'
import sys
try:
    from coworld.api_client import CoworldApiClient
    name, server = sys.argv[1], sys.argv[2]
    with CoworldApiClient.from_login(server_url=server) as client:
        pv = client.lookup_policy_version(name=name)
        print(pv.id if pv is not None else "")
except Exception:
    print("")
PY
)"

echo
if [ -n "$POLICY_ID" ]; then
  cat <<EOF
Done. Your Bedrock-powered agent is uploaded. Your policy id is:

    $POLICY_ID

Send that id to whoever is running the match and they'll seat your agent.
EOF
else
  cat <<'EOF'
Uploaded, but could not auto-read the policy id.
Open https://softmax.com/observatory -> your policy's page, copy the
policy-version id, and send it to whoever is running the match.
EOF
fi
