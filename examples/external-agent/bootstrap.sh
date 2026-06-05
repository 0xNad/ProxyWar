#!/usr/bin/env bash
set -euo pipefail

STARTER_REPO_URL="${PROXYWAR_STARTER_REPO_URL:-https://github.com/0xNad/ProxyWar-starter-agent.git}"
BETA_URL="${PROXYWAR_BETA_URL:-https://beta.proxywar.xyz}"
WORKDIR="${PROXYWAR_STARTER_WORKDIR:-ProxyWar-starter-agent}"
PROVIDER="${PROXYWAR_AGENT_BOOTSTRAP_PROVIDER:-auto}"
COMMAND_VALUE="${PROXYWAR_AGENT_LLM_COMMAND:-}"
INVITE_CODE="${PROXYWAR_BETA_INVITE_CODE:-}"
CONNECT_MODE="${PROXYWAR_AGENT_CONNECT_MODE:-relay}"
PUBLIC_URL="${PROXYWAR_AGENT_PUBLIC_URL:-}"
TUNNEL_MODE="${PROXYWAR_AGENT_TUNNEL:-auto}"
AUTO_IMPORT="auto"
PORT="${PROXYWAR_AGENT_PORT:-}"
JOB_TIMEOUT_SECONDS="${PROXYWAR_AGENT_BOOTSTRAP_JOB_TIMEOUT_SECONDS:-1800}"
EXIT_AFTER_READY="${PROXYWAR_AGENT_BOOTSTRAP_EXIT_AFTER_READY:-false}"

server_pid=""
tunnel_pid=""
relay_worker_pid=""
server_log=""
tunnel_log=""
relay_worker_log=""
endpoint_token=""
selected_provider=""

usage() {
  cat <<'USAGE'
ProxyWar one-command external-agent bootstrap

Usage:
  curl -fsSL https://beta.proxywar.xyz/agent-start.sh | bash -s -- [options]

Default:
  --relay is the default. It uses Managed Agent Relay: your machine connects
  outbound to Proxy War, receives decision requests, calls Codex CLI,
  Claude/Cowork, a custom command, or OpenRouter locally, then posts decisions
  back. No public local endpoint, no tunnel, and no inbound port are needed.

Options:
  --beta-url URL          Proxy War beta URL. Default: https://beta.proxywar.xyz
  --invite-code CODE     Log in, create a relay session, queue a match, and poll replay.
  --relay                Managed relay mode. Default and recommended.
  --http-agent-card      Advanced: expose /agent-card.md and /proxywar/decide.
  --provider NAME        auto, codex-cli, claude-cowork, command, or openrouter. Default: auto
  --command COMMAND      Custom non-interactive command for provider=command.
  --workdir DIR          Starter checkout path. Default: ./ProxyWar-starter-agent
  --public-url URL       Advanced HTTP mode: existing public HTTPS base URL.
  --tunnel MODE          Advanced HTTP mode: auto, cloudflared, localtunnel, or none.
  --port PORT            Advanced HTTP mode local port. Default: first free 7777-7787.
  --no-import            Preflight only; do not create relay/import or queue a match.
  --local-only           Advanced HTTP local endpoint checks only.
  --exit-after-ready     Advanced HTTP mode: exit after self-tests.
  -h, --help             Show this help.

What this does in relay mode:
  1. Checks git, Node.js 20+, npm, and curl.
  2. Clones or fast-forwards the public starter repo.
  3. Finds a working Codex CLI, Claude/Cowork, custom command, or OpenRouter backend.
  4. Runs relay self-test before contacting Proxy War.
  5. Logs into beta, creates /api/agent-relay/sessions, starts the relay worker,
     queues a saved-agent match, then prints replay and feedback links.

Advanced HTTP Agent Card mode still exists for developers who already operate
a public HTTPS endpoint. It uses PROXYWAR_AGENT_ENDPOINT_TOKEN, can open
cloudflared/localtunnel, then calls /api/agent-cards/import-and-run.
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --beta-url)
      BETA_URL="${2:-}"
      shift 2
      ;;
    --invite-code)
      INVITE_CODE="${2:-}"
      shift 2
      ;;
    --relay)
      CONNECT_MODE="relay"
      shift
      ;;
    --http-agent-card)
      CONNECT_MODE="http"
      shift
      ;;
    --provider)
      PROVIDER="${2:-}"
      shift 2
      ;;
    --command)
      COMMAND_VALUE="${2:-}"
      PROVIDER="command"
      shift 2
      ;;
    --workdir)
      WORKDIR="${2:-}"
      shift 2
      ;;
    --public-url)
      CONNECT_MODE="http"
      PUBLIC_URL="${2:-}"
      shift 2
      ;;
    --tunnel)
      CONNECT_MODE="http"
      TUNNEL_MODE="${2:-}"
      shift 2
      ;;
    --port)
      CONNECT_MODE="http"
      PORT="${2:-}"
      shift 2
      ;;
    --no-import)
      AUTO_IMPORT="false"
      shift
      ;;
    --local-only)
      CONNECT_MODE="http"
      TUNNEL_MODE="none"
      AUTO_IMPORT="false"
      shift
      ;;
    --exit-after-ready)
      EXIT_AFTER_READY="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() { printf '%s\n' "==> $*"; }
warn() { printf '%s\n' "WARN: $*" >&2; }
fail() { printf '%s\n' "ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

cleanup() {
  if [[ -n "${relay_worker_pid:-}" ]] && kill -0 "$relay_worker_pid" >/dev/null 2>&1; then
    kill "$relay_worker_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "${tunnel_pid:-}" ]] && kill -0 "$tunnel_pid" >/dev/null 2>&1; then
    kill "$tunnel_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "${server_pid:-}" ]] && kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

normalize_url() {
  printf '%s' "$1" | sed 's#/*$##'
}

BETA_URL="$(normalize_url "$BETA_URL")"
PUBLIC_URL="$(normalize_url "$PUBLIC_URL")"

case "$CONNECT_MODE" in
  relay|http) ;;
  *) fail "PROXYWAR_AGENT_CONNECT_MODE must be relay or http." ;;
esac
case "$PROVIDER" in
  auto|codex-cli|claude-cowork|command|openrouter) ;;
  *) fail "--provider must be auto, codex-cli, claude-cowork, command, or openrouter." ;;
esac
case "$TUNNEL_MODE" in
  auto|cloudflared|localtunnel|none) ;;
  *) fail "--tunnel must be auto, cloudflared, localtunnel, or none." ;;
esac

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! have "$command_name"; then
    fail "$command_name is required. $install_hint"
  fi
}

require_command git "Install Git, then rerun the bootstrap command."
require_command node "Install Node.js 20 or newer, then rerun the bootstrap command."
require_command npm "Install npm with Node.js 20 or newer, then rerun the bootstrap command."
require_command curl "Install curl, then rerun the bootstrap command."

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1);'; then
  fail "Node.js 20 or newer is required. Current version: $(node --version 2>/dev/null || echo unknown)."
fi
if [[ "$PROVIDER" == "command" && -z "$COMMAND_VALUE" ]]; then
  fail "provider=command requires --command \"your-non-interactive-command\"."
fi
if [[ "$PROVIDER" == "openrouter" && -z "${OPENROUTER_API_KEY:-}" ]]; then
  fail "provider=openrouter requires OPENROUTER_API_KEY. Use --provider auto, codex-cli, claude-cowork, or --command if you do not want an API key."
fi

starter_has_relay_files() {
  local dir="$1"
  [[ -f "$dir/relay-worker.mjs" && -f "$dir/package.json" ]] || return 1
  node - "$dir/package.json" <<'NODE'
const fs = require("node:fs");
try {
  const packageJson = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const scripts = packageJson.scripts ?? {};
  process.exit(typeof scripts.relay === "string" && scripts.relay.includes("relay-worker.mjs") ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

download_hosted_starter_runtime() {
  local runtime_dir="$1"
  if [[ -e "$runtime_dir" && ! -f "$runtime_dir/.proxywar-relay-runtime" ]]; then
    fail "$runtime_dir exists and is not managed by this bootstrap. Move it aside or pass --workdir."
  fi
  rm -rf "$runtime_dir"
  mkdir -p "$runtime_dir"
  local files=(
    "README.md"
    "simple-agent.mjs"
    "relay-worker.mjs"
    "starter-framework.mjs"
    "agent-policy.mjs"
    "manifest.example.json"
    "package.json"
    "launch.sh"
    "bootstrap.sh"
    ".env.example"
    "LICENSE"
    "PROXYWAR_AGENT_CARD.md"
    "AGENT_SKILL.md"
  )
  log "Downloading beta-hosted relay starter files into $runtime_dir"
  local file
  for file in "${files[@]}"; do
    curl -fsSL "${BETA_URL}/examples/external-agent/${file}" -o "${runtime_dir}/${file}" || {
      fail "Could not download ${BETA_URL}/examples/external-agent/${file}. Check --beta-url and network access."
    }
  done
  chmod +x "${runtime_dir}/launch.sh" "${runtime_dir}/bootstrap.sh" || true
  touch "$runtime_dir/.proxywar-relay-runtime"
  if ! starter_has_relay_files "$runtime_dir"; then
    fail "Beta-hosted starter files are missing relay-worker.mjs or npm run relay. The beta host is stale; do not send this command to testers yet."
  fi
}

log "Preparing starter repo in $WORKDIR"
if [[ -d "$WORKDIR/.git" ]]; then
  (
    cd "$WORKDIR"
    if [[ -n "$(git status --porcelain)" ]]; then
      fail "$WORKDIR has local changes. Move it aside or commit them, then rerun."
    fi
    git fetch origin main --quiet
    git checkout main --quiet
    git pull --ff-only --quiet
  )
elif [[ -e "$WORKDIR" ]]; then
  fail "$WORKDIR exists but is not a Git checkout. Move it aside or pass --workdir."
else
  git clone --depth 1 "$STARTER_REPO_URL" "$WORKDIR"
fi

if [[ "$CONNECT_MODE" == "relay" ]] && ! starter_has_relay_files "$WORKDIR"; then
  runtime_workdir="${WORKDIR%/}.relay-runtime"
  warn "The starter checkout at $WORKDIR does not include Managed Agent Relay files yet."
  warn "Using beta-hosted starter runtime instead; no public endpoint or tunnel will be opened."
  download_hosted_starter_runtime "$runtime_workdir"
  WORKDIR="$runtime_workdir"
fi

cd "$WORKDIR"

log "Installing starter dependencies"
npm install

if [[ -n "$COMMAND_VALUE" ]]; then
  export PROXYWAR_AGENT_LLM_COMMAND="$COMMAND_VALUE"
fi
export PROXYWAR_AGENT_ENDPOINT_TIMEOUT_MS="${PROXYWAR_AGENT_ENDPOINT_TIMEOUT_MS:-120000}"
export PROXYWAR_AGENT_LLM_TIMEOUT_MS="${PROXYWAR_AGENT_LLM_TIMEOUT_MS:-12000}"
export PROXYWAR_AGENT_LLM_POLICY_REUSE_DECISIONS="${PROXYWAR_AGENT_LLM_POLICY_REUSE_DECISIONS:-1}"
export PROXYWAR_AGENT_TEST_TIMEOUT_MS="${PROXYWAR_AGENT_TEST_TIMEOUT_MS:-180000}"

candidate_providers() {
  if [[ "$PROVIDER" != "auto" ]]; then
    printf '%s\n' "$PROVIDER"
    return
  fi
  if [[ -n "$COMMAND_VALUE" ]]; then printf '%s\n' "command"; fi
  if have codex; then printf '%s\n' "codex-cli"; fi
  if have claude; then printf '%s\n' "claude-cowork"; fi
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then printf '%s\n' "openrouter"; fi
}

provider_fix_hint() {
  local provider="$1"
  cat <<EOF
Provider $provider failed preflight.
Fix:
  - Codex CLI: install/log in, then rerun with --provider codex-cli.
  - Claude/Cowork: confirm \`which claude\`, run \`claude\`, type /login, exit, then rerun with --provider claude-cowork.
  - Custom command: pass --command "tool --json" and make it print strict JSON only.
  - OpenRouter: export OPENROUTER_API_KEY and rerun with --provider openrouter.
EOF
}

self_test_relay_provider() {
  local provider="$1"
  if [[ "$provider" == "codex-cli" ]] && ! have codex; then
    warn "Skipping codex-cli: no codex command on PATH."
    return 1
  fi
  if [[ "$provider" == "claude-cowork" ]] && ! have claude && [[ -z "${CLAUDE_COMMAND:-}" ]]; then
    warn "Skipping claude-cowork: no claude command on PATH."
    return 1
  fi
  if [[ "$provider" == "openrouter" && -z "${OPENROUTER_API_KEY:-}" ]]; then
    warn "Skipping openrouter: OPENROUTER_API_KEY is empty."
    return 1
  fi
  if [[ "$provider" == "command" && -z "${PROXYWAR_AGENT_LLM_COMMAND:-}" ]]; then
    warn "Skipping command: no custom command was provided."
    return 1
  fi

  export PROXYWAR_AGENT_LLM_PROVIDER="$provider"
  log "Running relay self-test with provider: $provider"
  if npm run relay -- --self-test; then
    log "Provider passed relay self-test: $provider"
    return 0
  fi
  provider_fix_hint "$provider" >&2
  return 1
}

find_free_port() {
  if [[ -n "$PORT" ]]; then
    node - "$PORT" <<'NODE'
const net = require("node:net");
const port = Number(process.argv[2]);
const server = net.createServer();
server.once("error", () => process.exit(1));
server.listen({ host: "127.0.0.1", port }, () => server.close(() => process.exit(0)));
NODE
    return
  fi
  for candidate in 7777 7778 7779 7780 7781 7782 7783 7784 7785 7786 7787; do
    if node - "$candidate" <<'NODE' >/dev/null 2>&1
const net = require("node:net");
const port = Number(process.argv[2]);
const server = net.createServer();
server.once("error", () => process.exit(1));
server.listen({ host: "127.0.0.1", port }, () => server.close(() => process.exit(0)));
NODE
    then
      PORT="$candidate"
      return
    fi
  done
  fail "No free local port found from 7777 to 7787. Stop old starter terminals and rerun."
}

stop_server() {
  if [[ -n "${server_pid:-}" ]] && kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  server_pid=""
}

wait_for_local_health() {
  local health_url="http://127.0.0.1:${PORT}/health"
  for _ in $(seq 1 120); do
    if [[ -n "${server_pid:-}" ]] && ! kill -0 "$server_pid" >/dev/null 2>&1; then
      return 1
    fi
    if node - "$health_url" <<'NODE' >/dev/null 2>&1
const url = process.argv[2];
fetch(url).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));
NODE
    then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

self_test_http_provider() {
  local provider="$1"
  if ! self_test_relay_provider "$provider"; then
    return 1
  fi
  stop_server
  export PROXYWAR_AGENT_LLM_PROVIDER="$provider"
  server_log="${TMPDIR:-/tmp}/proxywar-bootstrap-server.${provider//[^A-Za-z0-9_-]/_}.$$.log"
  log "Starting advanced HTTP starter with provider: $provider"
  npm start >"$server_log" 2>&1 &
  server_pid="$!"
  if ! wait_for_local_health; then
    warn "Starter did not become healthy with provider $provider."
    tail -80 "$server_log" >&2 || true
    stop_server
    return 1
  fi
  if PROXYWAR_AGENT_TEST_ENDPOINT_URL="http://127.0.0.1:${PORT}/proxywar/decide" \
     PROXYWAR_AGENT_TEST_TOKEN="$endpoint_token" \
     npm run self-test; then
    log "Provider passed advanced HTTP self-test: $provider"
    return 0
  fi
  tail -80 "$server_log" >&2 || true
  stop_server
  return 1
}

select_provider() {
  local providers=()
  while IFS= read -r provider; do
    [[ -n "$provider" ]] && providers+=("$provider")
  done < <(candidate_providers)
  if [[ "${#providers[@]}" -eq 0 ]]; then
    fail "No local LLM backend found. Install/log in to Codex CLI or Claude CLI, pass --command, or set OPENROUTER_API_KEY."
  fi
  for provider in "${providers[@]}"; do
    if [[ "$CONNECT_MODE" == "relay" ]]; then
      if self_test_relay_provider "$provider"; then
        selected_provider="$provider"
        return
      fi
    else
      if self_test_http_provider "$provider"; then
        selected_provider="$provider"
        return
      fi
    fi
    if [[ "$PROVIDER" != "auto" ]]; then
      fail "Provider $provider failed preflight. Fix the error above, then rerun."
    fi
    warn "Trying next available provider."
  done
  fail "All available providers failed preflight. Log in to Codex/Claude CLI, pass a working --command, or set OPENROUTER_API_KEY."
}

json_field() {
  local file="$1"
  local field="$2"
  node - "$file" "$field" <<'NODE'
const fs = require("node:fs");
let value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const part of process.argv[3].split(".")) value = value?.[part];
if (value !== undefined && value !== null) process.stdout.write(String(value));
NODE
}

json_object_field() {
  local file="$1"
  local field="$2"
  node - "$file" "$field" <<'NODE'
const fs = require("node:fs");
let value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const part of process.argv[3].split(".")) value = value?.[part];
if (value === undefined || value === null || typeof value !== "object") process.exit(1);
process.stdout.write(JSON.stringify(value));
NODE
}

join_url() {
  local base="$1"
  local path="$2"
  if [[ "$path" == http://* || "$path" == https://* ]]; then
    printf '%s' "$path"
  else
    printf '%s/%s' "$(normalize_url "$base")" "${path#/}"
  fi
}

login_beta() {
  local cookie_jar="$1"
  local body_file="$2"
  local status_code
  log "Logging into Proxy War beta"
  status_code="$(curl -sS -L -c "$cookie_jar" -b "$cookie_jar" -o "$body_file" -w '%{http_code}' --data-urlencode "inviteCode=$INVITE_CODE" --data-urlencode "returnTo=/public" "${BETA_URL}/api/beta/login")"
  if [[ "$status_code" -lt 200 || "$status_code" -ge 400 ]]; then
    cat "$body_file" >&2 || true
    fail "Beta login failed with HTTP $status_code. Check the invite code."
  fi
}

relay_session_active_in_file() {
  local file="$1"
  local session_id="$2"
  node - "$file" "$session_id" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sessionID = process.argv[3];
const results = Array.isArray(body.results) ? body.results : [];
const active = results.some((item) =>
  item &&
  item.ok === true &&
  typeof item.endpoint === "string" &&
  item.endpoint.includes(sessionID)
);
process.exit(active ? 0 : 1);
NODE
}

wait_for_relay_session_active() {
  local cookie_jar="$1"
  local body_file="$2"
  local session_id="$3"
  local status_code
  log "Waiting for relay worker to connect"
  for _ in $(seq 1 60); do
    status_code="$(curl -sS -b "$cookie_jar" -X POST -o "$body_file" -w '%{http_code}' "${BETA_URL}/api/tester-dashboard/endpoint-health")"
    if [[ "$status_code" -ge 200 && "$status_code" -lt 300 ]] && relay_session_active_in_file "$body_file" "$session_id"; then
      log "Relay worker is active"
      return 0
    fi
    sleep 1
  done
  cat "$body_file" >&2 || true
  return 1
}

login_create_relay_and_run() {
  if [[ -z "$INVITE_CODE" ]]; then
    fail "Managed relay beta play requires --invite-code. Rerun with --invite-code \"...\"."
  fi
  local cookie_jar body_file status_code relay_json
  cookie_jar="$(mktemp)"
  body_file="$(mktemp)"
  login_beta "$cookie_jar" "$body_file"
  log "Creating Managed Agent Relay session"
  relay_json="$(SELECTED_PROVIDER="$selected_provider" node - <<'NODE'
process.stdout.write(JSON.stringify({
  agentName: process.env.PROXYWAR_AGENT_NAME || "Relay Frontier",
  profile: process.env.PROXYWAR_AGENT_PROFILE || "opportunistic",
  doctrine: process.env.PROXYWAR_AGENT_DOCTRINE || "balanced",
  personality: "Managed relay starter agent. Local model stays on tester machine.",
  policyChangelog: `Connected through Managed Agent Relay with ${process.env.SELECTED_PROVIDER || "local CLI"}.`,
  timeoutMs: Number(process.env.PROXYWAR_AGENT_ENDPOINT_TIMEOUT_MS || 120000),
  queueMatch: false,
}));
NODE
)"
  status_code="$(curl -sS -b "$cookie_jar" -H 'content-type: application/json' -o "$body_file" -w '%{http_code}' --data "$relay_json" "${BETA_URL}/api/agent-relay/sessions")"
  if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
    cat "$body_file" >&2 || true
    fail "Managed relay session setup failed with HTTP $status_code."
  fi

  local session_id session_token poll_url decisions_url job_request job_status_path job_url
  session_id="$(json_field "$body_file" "relay.sessionID")"
  session_token="$(json_field "$body_file" "relay.sessionToken")"
  poll_url="$(json_field "$body_file" "relay.pollUrl")"
  decisions_url="$(json_field "$body_file" "relay.decisionsUrl")"
  job_request="$(json_object_field "$body_file" "jobRequest")"
  if [[ -z "$session_id" || -z "$session_token" || -z "$job_request" ]]; then
    cat "$body_file" >&2 || true
    fail "Managed relay setup did not return relay session and jobRequest."
  fi

  relay_worker_log="${TMPDIR:-/tmp}/proxywar-relay-worker.$$.log"
  log "Starting outbound relay worker"
  PROXYWAR_BETA_URL="$BETA_URL" \
  PROXYWAR_AGENT_RELAY_SESSION_ID="$session_id" \
  PROXYWAR_AGENT_RELAY_TOKEN="$session_token" \
  PROXYWAR_AGENT_RELAY_POLL_URL="$poll_url" \
  PROXYWAR_AGENT_RELAY_DECISIONS_URL="$decisions_url" \
    npm run relay >"$relay_worker_log" 2>&1 &
  relay_worker_pid="$!"
  sleep 1
  if ! kill -0 "$relay_worker_pid" >/dev/null 2>&1; then
    tail -80 "$relay_worker_log" >&2 || true
    fail "Relay worker exited before connecting. Fix the provider error above and rerun."
  fi
  if ! wait_for_relay_session_active "$cookie_jar" "$body_file" "$session_id"; then
    tail -80 "$relay_worker_log" >&2 || true
    fail "Relay worker did not become active. Keep the terminal open, fix provider errors, and rerun."
  fi

  log "Queueing winner-required beta match"
  status_code="$(curl -sS -b "$cookie_jar" -H 'content-type: application/json' -o "$body_file" -w '%{http_code}' --data "$job_request" "${BETA_URL}/api/jobs")"
  if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
    cat "$body_file" >&2 || true
    fail "Match queue failed with HTTP $status_code."
  fi
  job_status_path="/api/jobs/$(json_field "$body_file" "jobID")"
  job_url="$(join_url "$BETA_URL" "$job_status_path")"
  log "Match queued. Polling job: $job_url"
  local started_at last_status
  started_at="$(date +%s)"
  last_status=""
  while true; do
    status_code="$(curl -sS -b "$cookie_jar" -o "$body_file" -w '%{http_code}' "$job_url")"
    if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
      cat "$body_file" >&2 || true
      fail "Job poll failed with HTTP $status_code."
    fi
    local status
    status="$(json_field "$body_file" "status")"
    if [[ "$status" != "$last_status" ]]; then
      log "Match status: ${status:-unknown}"
      last_status="$status"
    fi
    if [[ "$status" == "completed" ]]; then
      local replay_path run_id feedback_path
      replay_path="$(json_field "$body_file" "replayUrl")"
      run_id="$(json_field "$body_file" "latestRunID")"
      feedback_path="/runs/${run_id}/external-agent-feedback.md"
      printf '\nMatch completed.\n\nReplay:\n%s\n\nExternal-agent feedback:\n%s\n\n' "$(join_url "$BETA_URL" "$replay_path")" "$(join_url "$BETA_URL" "$feedback_path")"
      return 0
    fi
    if [[ "$status" == "failed" ]]; then
      tail -80 "$relay_worker_log" >&2 || true
      fail "Match failed: $(json_field "$body_file" "errorSummary")"
    fi
    if (( $(date +%s) - started_at > JOB_TIMEOUT_SECONDS )); then
      fail "Timed out waiting for match completion after ${JOB_TIMEOUT_SECONDS}s. Job URL: $job_url"
    fi
    sleep 5
  done
}

wait_for_http_ok() {
  local url="$1"
  for _ in $(seq 1 "${PROXYWAR_AGENT_BOOTSTRAP_HTTP_ATTEMPTS:-40}"); do
    if curl -fsS --max-time "${PROXYWAR_AGENT_BOOTSTRAP_CURL_TIMEOUT_SECONDS:-8}" "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_tunnel() {
  if [[ -n "$PUBLIC_URL" ]]; then
    log "Using provided public URL: $PUBLIC_URL"
    return 0
  fi
  if [[ "$TUNNEL_MODE" == "none" ]]; then
    PUBLIC_URL="http://127.0.0.1:${PORT}"
    warn "Tunnel disabled. This local URL will not work from hosted beta."
    return 0
  fi
  tunnel_log="${TMPDIR:-/tmp}/proxywar-bootstrap-tunnel.$$.log"
  if [[ "$TUNNEL_MODE" == "cloudflared" || "$TUNNEL_MODE" == "auto" ]]; then
    if have cloudflared; then
      log "Opening Cloudflare quick tunnel"
      cloudflared tunnel --url "http://127.0.0.1:${PORT}" --protocol http2 --no-autoupdate >"$tunnel_log" 2>&1 &
      tunnel_pid="$!"
    elif [[ "$TUNNEL_MODE" == "cloudflared" ]]; then
      fail "cloudflared is not installed. On macOS: brew install cloudflared."
    fi
  fi
  if [[ -z "${tunnel_pid:-}" ]] && [[ "$TUNNEL_MODE" == "localtunnel" || "$TUNNEL_MODE" == "auto" ]]; then
    if ! have npx; then
      fail "No tunnel tool available. Install cloudflared, or install npm/npx and rerun."
    fi
    log "Opening fallback localtunnel"
    npx --yes localtunnel --port "$PORT" --local-host 127.0.0.1 >"$tunnel_log" 2>&1 &
    tunnel_pid="$!"
  fi
  if [[ -z "${tunnel_pid:-}" ]]; then
    fail "No tunnel could be started. Install cloudflared or pass --public-url."
  fi
  for _ in $(seq 1 120); do
    if ! kill -0 "$tunnel_pid" >/dev/null 2>&1; then
      cat "$tunnel_log" >&2 || true
      return 1
    fi
    PUBLIC_URL="$(grep -Eo 'https://[A-Za-z0-9.-]+(trycloudflare.com|loca.lt)' "$tunnel_log" 2>/dev/null | tail -1 || true)"
    PUBLIC_URL="$(normalize_url "$PUBLIC_URL")"
    if [[ -n "$PUBLIC_URL" ]]; then
      log "Public URL: $PUBLIC_URL"
      return 0
    fi
    sleep 1
  done
  cat "$tunnel_log" >&2 || true
  return 1
}

login_and_import_run() {
  if [[ -z "$INVITE_CODE" || "$AUTO_IMPORT" == "false" ]]; then
    return 0
  fi
  local cookie_jar body_file status_code card_url
  cookie_jar="$(mktemp)"
  body_file="$(mktemp)"
  login_beta "$cookie_jar" "$body_file"
  card_url="${PUBLIC_URL}/agent-card.md"
  log "Importing Agent Card and queueing a bounded match"
  status_code="$(curl -sS -b "$cookie_jar" -H 'content-type: application/json' -o "$body_file" -w '%{http_code}' --data "$(node -e "process.stdout.write(JSON.stringify({cardUrl: process.argv[1], endpointToken: process.argv[2]}))" "$card_url" "$endpoint_token")" "${BETA_URL}/api/agent-cards/import-and-run")"
  if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
    cat "$body_file" >&2 || true
    fail "Agent Card import-and-run failed with HTTP $status_code."
  fi
  local job_url
  job_url="$(join_url "$BETA_URL" "$(json_field "$body_file" "jobStatusUrl")")"
  log "Match queued. Polling job: $job_url"
  local started_at
  started_at="$(date +%s)"
  while true; do
    status_code="$(curl -sS -b "$cookie_jar" -o "$body_file" -w '%{http_code}' "$job_url")"
    [[ "$status_code" -ge 200 && "$status_code" -lt 300 ]] || fail "Job poll failed with HTTP $status_code."
    local status
    status="$(json_field "$body_file" "status")"
    if [[ "$status" == "completed" ]]; then
      local replay_path run_id
      replay_path="$(json_field "$body_file" "replayUrl")"
      run_id="$(json_field "$body_file" "latestRunID")"
      printf '\nMatch completed.\n\nReplay:\n%s\n\nExternal-agent feedback:\n%s\n\n' "$(join_url "$BETA_URL" "$replay_path")" "$(join_url "$BETA_URL" "/runs/${run_id}/external-agent-feedback.md")"
      return 0
    fi
    if [[ "$status" == "failed" ]]; then
      fail "Match failed: $(json_field "$body_file" "errorSummary")"
    fi
    if (( $(date +%s) - started_at > JOB_TIMEOUT_SECONDS )); then
      fail "Timed out waiting for match completion after ${JOB_TIMEOUT_SECONDS}s. Job URL: $job_url"
    fi
    sleep 5
  done
}

if [[ "$CONNECT_MODE" == "relay" ]]; then
  select_provider
  if [[ "$AUTO_IMPORT" == "false" ]]; then
    log "Relay provider self-test passed. --no-import was passed, so no beta relay session or match was started."
    exit 0
  fi
  login_create_relay_and_run
  exit 0
fi

find_free_port
endpoint_token="${PROXYWAR_AGENT_ENDPOINT_TOKEN:-}"
if [[ -z "$endpoint_token" ]]; then
  endpoint_token="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
fi
export PROXYWAR_AGENT_HOST="127.0.0.1"
export PROXYWAR_AGENT_PORT="$PORT"
export PROXYWAR_AGENT_ENDPOINT_TOKEN="$endpoint_token"
select_provider

if ! start_tunnel; then
  fail "Could not open a public HTTPS tunnel. Install cloudflared and rerun: brew install cloudflared"
fi
export PROXYWAR_AGENT_PUBLIC_URL="$PUBLIC_URL"
if ! wait_for_http_ok "${PUBLIC_URL}/health" || ! wait_for_http_ok "${PUBLIC_URL}/agent-card.md"; then
  fail "Public endpoint did not become reachable. Check the tunnel log: $tunnel_log"
fi
if [[ "$TUNNEL_MODE" != "none" || "$PUBLIC_URL" == https://* ]]; then
  log "Running public self-test through the shared URL"
  PROXYWAR_AGENT_TEST_ENDPOINT_URL="${PUBLIC_URL}/proxywar/decide" \
  PROXYWAR_AGENT_TEST_TOKEN="$endpoint_token" \
    npm run self-test
fi

cat <<EOF

ProxyWar starter HTTP Agent Card mode is ready.

Agent Card URL:
${PUBLIC_URL}/agent-card.md

Decision endpoint:
${PUBLIC_URL}/proxywar/decide

Endpoint token:
$endpoint_token

Use this only in advanced HTTP mode. The default relay mode avoids public
local endpoints and tunnels.

EOF

login_and_import_run

if [[ "$EXIT_AFTER_READY" == "true" ]]; then
  exit 0
fi

log "Keeping advanced HTTP endpoint open. Press Ctrl-C to stop."
while true; do sleep 3600; done
