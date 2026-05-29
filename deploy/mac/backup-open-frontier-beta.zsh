#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${OPEN_FRONTIER_PROJECT_DIR:-$HOME/Documents/OpenFrontier}"
ENV_FILE="${OPEN_FRONTIER_ENV_FILE:-$HOME/.open-frontier/open-frontier-beta.env}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "Open Frontier project directory not found: $PROJECT_DIR" >&2
  exit 64
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Open Frontier beta env file not found: $ENV_FILE" >&2
  exit 64
fi

set -a
source "$ENV_FILE"
set +a

cd "$PROJECT_DIR"
exec npm run agent:hosted-beta:backup
