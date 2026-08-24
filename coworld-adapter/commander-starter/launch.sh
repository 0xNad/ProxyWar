#!/usr/bin/env bash
set -euo pipefail

NAME="my-proxywar-commander"
YES="${PROXYWAR_COMMANDER_YES:-0}"
DOCTOR=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --doctor|--check) DOCTOR=1 ;;
    -h|--help)
      printf '%s\n' \
        'Usage: bash launch.sh [policy-name] [--yes] [--doctor]' \
        '' \
        '  policy-name  uploaded Coworld policy name (default: my-proxywar-commander)' \
        '  --yes        auto-approve safe setup steps' \
        '  --doctor     check prerequisites without changing anything'
      exit 0
      ;;
    -*) printf 'unknown flag: %s (try --help)\n' "$arg" >&2; exit 2 ;;
    *) NAME="$arg" ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="proxywar-commander-starter:latest"
MODEL="us.anthropic.claude-sonnet-4-6"
BLOCKED=0
AUTH=unknown

ok() { printf '  [ok]    %s\n' "$*"; }
note() { printf '  [--]    %s\n' "$*"; }
needs() { printf '  [needs] %s\n' "$*"; BLOCKED=1; }

confirm() {
  if [ "$YES" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  printf '%s [Y/n] ' "$1"
  read -r reply || return 1
  case "$reply" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
}

printf '%s\n' '==> Checking your setup...'
case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *) printf '%s\n' 'This starter supports macOS and Linux (use WSL on Windows).' >&2; exit 1 ;;
esac

if command -v uv >/dev/null 2>&1; then
  ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"
elif [ "$DOCTOR" = 1 ]; then
  needs 'uv is missing: https://docs.astral.sh/uv/'
elif confirm 'uv is missing. Install it in your user account now?'; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  command -v uv >/dev/null 2>&1 && ok 'uv installed' || needs 'uv installed but is not on PATH yet'
else
  needs 'uv is required: curl -LsSf https://astral.sh/uv/install.sh | sh'
fi

if ! command -v docker >/dev/null 2>&1; then
  needs 'Docker is required: https://docs.docker.com/get-docker/'
elif docker info >/dev/null 2>&1; then
  ok 'Docker is running'
elif [ "$OS" = mac ] && [ -d /Applications/Docker.app ] && [ "$DOCTOR" = 0 ] && confirm 'Start Docker Desktop now?'; then
  open -a Docker
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 3
  done
  docker info >/dev/null 2>&1 && ok 'Docker is running' || needs 'Docker did not become ready within 90 seconds'
else
  needs 'Docker is installed but its daemon is not running'
fi

if command -v uv >/dev/null 2>&1; then
  AUTH="$(uvx --from coworld python - 2>/dev/null <<'PY' || true
try:
    from coworld.api_client import CoworldApiClient
    with CoworldApiClient.from_login(server_url="https://softmax.com/api") as client:
        client.lookup_policy_version(name="proxywar-commander-auth-probe")
    print("ok")
except Exception:
    print("no")
PY
)"
  AUTH="$(printf '%s' "$AUTH" | tail -n 1)"
  [ "$AUTH" = ok ] && ok 'Softmax sign-in' || note 'Softmax sign-in will open in your browser during launch'
fi

if [ "$DOCTOR" = 1 ]; then
  [ "$BLOCKED" = 0 ] && printf '%s\n' 'Doctor: ready' || { printf '%s\n' 'Doctor: blocked'; exit 1; }
  exit 0
fi
if [ "$BLOCKED" = 1 ]; then exit 1; fi

if [ "$AUTH" != ok ]; then
  uvx --from softmax-cli softmax login
fi

printf '%s\n' '==> Building the pinned Commander image (linux/amd64)...'
docker build --platform linux/amd64 -t "$IMAGE" "$HERE"

printf "==> Uploading '%s' with Bedrock enabled...\n" "$NAME"
uvx --from coworld coworld upload-policy "$IMAGE" \
  --name "$NAME" \
  --use-bedrock \
  --bedrock-model "$MODEL" \
  --run node \
  --run=--import \
  --run tsx \
  --run /app/proxywar/coworld-adapter/src/commander-xp-player.ts \
  --run=--arm=C

POLICY_ID="$(uvx --from coworld python - "$NAME" <<'PY'
import sys
from coworld.api_client import CoworldApiClient
with CoworldApiClient.from_login(server_url="https://softmax.com/api") as client:
    policy = client.lookup_policy_version(name=sys.argv[1])
    print("" if policy is None else policy.id)
PY
)"

printf '\nUploaded Commander policy-version ID:\n\n    %s\n\n' "$POLICY_ID"
printf '%s\n' \
  'Enter it in Proxy War:' \
  '' \
  '    uvx --from coworld coworld leagues' \
  "    uvx --from coworld coworld submit \"$NAME\" --league <league_id>"
