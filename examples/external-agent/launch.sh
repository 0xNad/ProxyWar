#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
ProxyWar starter agent launcher

Usage:
  ./launch.sh [codex-cli|claude-cowork|command|openrouter] ["optional command"]

Examples:
  ./launch.sh codex-cli
  ./launch.sh claude-cowork
  ./launch.sh command "your-cowork-command --print-json"
  ./launch.sh openrouter

This script does not source .env. The Node starter reads .env itself so command
values with spaces, such as "claude -p {{prompt}}", do not get executed by bash.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f ".env" && -f ".env.example" ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

provider_arg="${1:-}"
if [[ -n "$provider_arg" ]]; then
  case "$provider_arg" in
    codex-cli|claude-cowork|command|openrouter)
      export PROXYWAR_AGENT_LLM_PROVIDER="$provider_arg"
      shift
      ;;
    *)
      echo "Unknown provider: $provider_arg" >&2
      usage >&2
      exit 2
      ;;
  esac
fi

if [[ "$#" -gt 0 ]]; then
  export PROXYWAR_AGENT_LLM_COMMAND="$*"
fi

env_value() {
  local key="$1"
  node - "$key" <<'NODE'
const fs = require("node:fs");
const key = process.argv[2];
if (process.env[key] && process.env[key].trim() !== "") {
  console.log(process.env[key].trim());
  process.exit(0);
}
let text = "";
try {
  text = fs.readFileSync(".env", "utf8");
} catch {
  process.exit(0);
}
for (const line of text.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;
  const equals = trimmed.indexOf("=");
  if (equals <= 0) continue;
  const name = trimmed.slice(0, equals).trim();
  if (name !== key) continue;
  let value = trimmed.slice(equals + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  console.log(value.trim());
  process.exit(0);
}
NODE
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required before launching the starter." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required before launching the starter." >&2
  exit 1
fi

provider="$(env_value PROXYWAR_AGENT_LLM_PROVIDER)"
command_value="$(env_value PROXYWAR_AGENT_LLM_COMMAND)"
if [[ -z "$provider" && -n "$command_value" ]]; then
  provider="command"
  echo "Using PROXYWAR_AGENT_LLM_COMMAND from .env."
fi
if [[ -z "$provider" ]]; then
  export PROXYWAR_AGENT_LLM_PROVIDER="codex-cli"
  provider="codex-cli"
  echo "No LLM provider configured; defaulting this launch to codex-cli."
fi
export PROXYWAR_AGENT_ENDPOINT_TIMEOUT_MS="${PROXYWAR_AGENT_ENDPOINT_TIMEOUT_MS:-120000}"

host="$(env_value PROXYWAR_AGENT_HOST)"
port="$(env_value PROXYWAR_AGENT_PORT)"
host="${host:-127.0.0.1}"
port="${port:-7777}"
health_host="$host"
if [[ "$health_host" == "0.0.0.0" || "$health_host" == "::" ]]; then
  health_host="127.0.0.1"
fi
health_url="http://${health_host}:${port}/health"
decision_url="http://${health_host}:${port}/proxywar/decide"
log_file="${TMPDIR:-/tmp}/proxywar-starter-agent.$$.log"

echo "Starting ProxyWar starter agent with provider: $provider"
echo "Server log: $log_file"

node simple-agent.mjs >"$log_file" 2>&1 &
server_pid="$!"

cleanup() {
  if kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

ready=0
for _ in {1..60}; do
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    echo "Starter server exited before it became healthy." >&2
    sed -n '1,160p' "$log_file" >&2 || true
    exit 1
  fi
  if node - "$health_url" <<'NODE' >/dev/null 2>&1
const url = process.argv[2];
fetch(url).then((response) => {
  process.exit(response.ok ? 0 : 1);
}).catch(() => process.exit(1));
NODE
  then
    ready=1
    break
  fi
  sleep 0.5
done

if [[ "$ready" != "1" ]]; then
  echo "Starter server did not answer $health_url within 30 seconds." >&2
  sed -n '1,160p' "$log_file" >&2 || true
  exit 1
fi

echo "Server is healthy at $health_url."
echo "Running starter self-test. First local CLI runs can take a minute or two."
export PROXYWAR_AGENT_TEST_TIMEOUT_MS="${PROXYWAR_AGENT_TEST_TIMEOUT_MS:-180000}"
export PROXYWAR_AGENT_TEST_ENDPOINT_URL="${PROXYWAR_AGENT_TEST_ENDPOINT_URL:-$decision_url}"

if ! npm run self-test; then
  echo
  echo "Self-test failed. Last starter server log lines:" >&2
  tail -80 "$log_file" >&2 || true
  echo >&2
  echo "Fix the provider/command output, then run ./launch.sh again." >&2
  exit 1
fi

echo
echo "Starter is ready."
echo "Agent Card: http://${health_host}:${port}/agent-card.md"
echo "Decision endpoint: $decision_url"
echo "Keep this terminal open. Stop with Ctrl+C."
wait "$server_pid"
