#!/bin/zsh
# launchd entry point for the PLATFORM account origin (app.proxywar.xyz).
#
# This is the sole account and session authority: GitHub sign-in, account
# records, display names, lineage claims, the handoff codes children redeem,
# and the player profile pages. Runs with wagering OFF — accounts existing
# without a market is the entire point of the identity re-scope.
#
# Lives here rather than in the deploy for the same reason the other agents
# do: it keeps the launchd entry point on a stable, non-TCC-restricted path.
#
# Independent of betting by design. It must keep serving accounts and profiles
# whether or not the betting autocycler or Coworld generation are running.
set -u

DEPLOY_DIR="${PROXYWAR_PLATFORM_DEPLOY_DIR:-$HOME/.proxywar-deploy/platform-origin}"

if [[ ! -d "$DEPLOY_DIR" ]]; then
  print -r -- "platform: deploy dir missing: $DEPLOY_DIR" >&2
  exit 78   # EX_CONFIG — permanent misconfiguration, not a transient fault
fi

STATE_ROOT="${PROXYWAR_PLATFORM_STATE_ROOT:-$HOME/.proxywar-deploy/platform-state}"
mkdir -p "$STATE_ROOT"
chmod 700 "$STATE_ROOT"

# No HMAC key is passed in, deliberately. loadOrCreatePlatformHmacKey mints and
# persists one (0600, no-follow, pinned to the state root) whenever no hex is
# configured, and unlike betting's premiere root this state root is durable and
# never wiped — so there is nothing to protect it from. Passing the key as an
# env value would put the session-signing key one `ps eww <pid>` away from
# cookie forgery, and passing a second copy by path would just duplicate
# ownership of a key the loader already owns correctly.

# GitHub OAuth credentials are optional. Absent means sign-in cleanly does not
# exist — no button, no routes — which is the correct unconfigured state. The
# secret is passed as a PATH, never a value: `ps eww <pid>` dumps a process's
# whole environment.
export PROXYWAR_GITHUB_OAUTH_CLIENT_ID="$(cat "$HOME/.proxywar-deploy/github-oauth-client-id" 2>/dev/null || true)"
export PROXYWAR_GITHUB_OAUTH_CLIENT_SECRET_FILE="$HOME/.proxywar-deploy/github-oauth-client-secret"

cd "$DEPLOY_DIR" || exit 78

export GAME_ENV=dev
export AI_LEAGUE_DEMO_PORT=8793
export PROXYWAR_PUBLIC_URL="https://proxywar.xyz"
export PROXYWAR_PLATFORM_ENABLED=1
# The apex, as of the 2026-07-30 cutover: the zone's "apex and www to league"
# redirect rule now matches www only, and the apex DNS record is a tunnel route
# (cloudflared tunnel route dns open-frontier-beta proxywar.xyz) landing here.
# app.proxywar.xyz stays in the tunnel ingress ONLY so the canonical-host 301
# is reachable there - it is not a second account surface: this value is the
# single expectedOrigin PlatformAccountSecurity accepts for writes, and the
# session cookie is host-only. The client's build-time define must match, so
# rebuild static/ with the same value (npx vite build) whenever this changes.
export PROXYWAR_PLATFORM_ORIGIN="https://proxywar.xyz"
# MUST be a JSON object of audience -> origin. A comma-separated list parses
# as invalid JSON, the whole allowlist is dropped, and /handoff/start then
# 400s for every audience - which is exactly the bug this line shipped with.
# The platform logs "PROXYWAR_PLATFORM_RETURN_ORIGINS is not valid JSON" when
# that happens; grep /tmp/pw-platform.log after changing this.
export PROXYWAR_PLATFORM_RETURN_ORIGINS='{"betting":"https://bet.proxywar.xyz","league":"https://beta.proxywar.xyz"}'
# Origins allowed an AMBIENT credentialed read of /api/account/pov-claims (the
# replay camera default). Deliberately NOT the same list as the handoff return
# origins above: a handoff child receives a redirect the user started, whereas
# an origin here can read a viewer's claims silently on any page load. The
# league needs it because league replays are served from beta; betting does not,
# because it reads its own same-origin snapshot. JSON array; empty denies all.
export PROXYWAR_PLATFORM_POV_CLAIM_ORIGINS='["https://beta.proxywar.xyz"]'
export PROXYWAR_PLATFORM_STATE_ROOT="$STATE_ROOT"
export PROXYWAR_LEAGUE_WRAPPER_ONLY=true
export PROXYWAR_ARTIFACTS_ROOT="$DEPLOY_DIR/artifacts"

exec npx tsx src/scripts/ai-agent-demo-server.ts
