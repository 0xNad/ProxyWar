#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${PROXYWAR_PROJECT_DIR:-$HOME/Documents/ProxyWar}"
ENV_FILE="${PROXYWAR_ENV_FILE:-$HOME/.proxywar/proxywar-beta.env}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "ProxyWar project directory not found: $PROJECT_DIR" >&2
  exit 64
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ProxyWar beta env file not found: $ENV_FILE" >&2
  exit 64
fi

set -a
source "$ENV_FILE"
set +a

cd "$PROJECT_DIR"
exec npm run agent:hosted-beta:backup
