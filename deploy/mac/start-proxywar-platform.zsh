#!/bin/zsh
# launchd entry point for the PLATFORM account origin (proxywar.xyz, the apex).
#
# This is the sole account and session authority: GitHub sign-in, account
# records, display names, lineage claims, and player profile pages.
#
# Lives here rather than in the deploy for the same reason the other agents
# do: it keeps the launchd entry point on a stable, non-TCC-restricted path.
#
# Independent of Coworld generation by design.
set -u

DEPLOY_DIR="${PROXYWAR_PLATFORM_DEPLOY_DIR:-$HOME/.proxywar-deploy/platform-origin}"

if [[ ! -d "$DEPLOY_DIR" ]]; then
  print -r -- "platform: deploy dir missing: $DEPLOY_DIR" >&2
  exit 78 # EX_CONFIG — permanent misconfiguration, not a transient fault
fi

STATE_ROOT="${PROXYWAR_PLATFORM_STATE_ROOT:-$HOME/.proxywar-deploy/platform-state}"
mkdir -p "$STATE_ROOT"
chmod 700 "$STATE_ROOT"

# No HMAC key is passed in, deliberately. loadOrCreatePlatformHmacKey mints and
# persists one (0600, no-follow, pinned to the state root) whenever no hex is
# configured, and this state root is durable and never wiped. Passing the key as an
# env value would put the session-signing key one `ps eww <pid>` away from
# cookie forgery, and passing a second copy by path would just duplicate
# ownership of a key the loader already owns correctly.

# GitHub OAuth credentials are optional. Absent means sign-in cleanly does not
# exist — no button, no routes — which is the correct unconfigured state. The
# secret is passed as a PATH, never a value: `ps eww <pid>` dumps a process's
# whole environment.
export PROXYWAR_GITHUB_OAUTH_CLIENT_ID="$(cat "$HOME/.proxywar-deploy/github-oauth-client-id" 2> /dev/null || true)"
export PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE="$HOME/.proxywar-deploy/github-oauth-client-secret"

cd "$DEPLOY_DIR" || exit 78

export GAME_ENV=dev
export AI_LEAGUE_DEMO_PORT=8793
export PROXYWAR_PUBLIC_URL="https://proxywar.xyz"
export PROXYWAR_PLATFORM_ENABLED=1
# The apex, as of the 2026-07-30 cutover: the zone's "apex and www to league"
# redirect rule now matches www only, and the apex DNS record is a tunnel route
# (cloudflared tunnel route dns proxywar-beta proxywar.xyz) landing here.
# app.proxywar.xyz stays in the tunnel ingress ONLY so the canonical-host 302
# is reachable there - it is not a second account surface: this value is the
# single expectedOrigin PlatformAccountSecurity accepts for writes, and the
# session cookie is host-only. The client's build-time define must match, so
# rebuild static/ with the same value (npx vite build) whenever this changes.
export PROXYWAR_PLATFORM_ORIGIN="https://proxywar.xyz"
export PROXYWAR_PLATFORM_STATE_ROOT="$STATE_ROOT"
export PROXYWAR_LEAGUE_WRAPPER_ONLY=true
export PROXYWAR_ARTIFACTS_ROOT="${PROXYWAR_ARTIFACTS_ROOT:-$DEPLOY_DIR/artifacts}"

exec npx tsx src/scripts/ai-agent-demo-server.ts
