#!/usr/bin/env bash
# Verify GitHub sign-in end to end on the hosted betting deploy.
#
#   ./verify-github-signin.sh
#
# Run this after registering the OAuth App and writing the two credential
# files (RUNBOOK.md 15.3a). It checks everything reachable without a browser:
# credentials present and correctly permissioned, routes mounted, the
# authorize redirect well-formed, and the callback refusing forged requests.
#
# The one thing it cannot check is a human clicking "Authorize" on github.com.
# Everything up to and after that is covered here.
set -uo pipefail

ORIGIN="${PW_BET_ORIGIN:-https://bet.proxywar.xyz}"
ID_FILE="${PW_BET_GITHUB_CLIENT_ID_FILE:-$HOME/.proxywar-deploy/github-oauth-client-id}"
SECRET_FILE="${PW_BET_GITHUB_CLIENT_SECRET_FILE:-$HOME/.proxywar-deploy/github-oauth-client-secret}"
AUTH="$ORIGIN/api/premieres/auth/github"
fails=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails + 1)); }
note() { printf '       %s\n' "$1"; }

echo "== credentials =="
if [ -s "$ID_FILE" ]; then
  ok "client id present ($(wc -c <"$ID_FILE" | tr -d ' ') bytes)"
else
  bad "client id missing or empty: $ID_FILE"
fi

if [ -s "$SECRET_FILE" ]; then
  mode="$(stat -f '%Lp' "$SECRET_FILE" 2>/dev/null || stat -c '%a' "$SECRET_FILE" 2>/dev/null)"
  if [ "$mode" = "600" ]; then
    ok "client secret present, mode $mode"
  else
    bad "client secret is mode $mode, must be 600 — the server will refuse it"
    note "chmod 600 $SECRET_FILE"
  fi
  # A trailing newline is trimmed by the resolver, but flag it: it means the
  # file was written with echo, and the next person may not be so lucky.
  if [ "$(tail -c 1 "$SECRET_FILE" | wc -l | tr -d ' ')" != "0" ]; then
    note "note: secret has a trailing newline (trimmed, but prefer printf over echo)"
  fi
else
  bad "client secret missing or empty: $SECRET_FILE"
fi

echo "== routes mounted =="
status_code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$AUTH/status")"
if [ "$status_code" = "404" ]; then
  bad "routes absent (status -> 404)"
  note "credentials unreadable at boot, or the origin has not restarted since."
  note "wait for the next cycle, or restart the origin, then re-run."
elif [ "$status_code" = "200" ]; then
  ok "status route mounted (200)"
else
  bad "status route returned $status_code"
fi

echo "== authorize redirect =="
loc="$(curl -s -o /dev/null -w '%{redirect_url}' -m 20 "$AUTH/start")"
if [ -z "$loc" ]; then
  bad "start did not redirect"
else
  case "$loc" in
    https://github.com/login/oauth/authorize\?*) ok "redirects to github authorize" ;;
    *) bad "unexpected redirect target: $loc" ;;
  esac
  case "$loc" in
    *redirect_uri=https%3A%2F%2Fbet.proxywar.xyz%2Fapi%2Fpremieres%2Fauth%2Fgithub%2Fcallback*)
      ok "callback matches the registered URL" ;;
    *) bad "callback in the redirect does not match the documented registration"
       note "$loc" ;;
  esac
  case "$loc" in
    *state=*) ok "carries a state nonce" ;;
    *) bad "no state parameter — CSRF protection missing" ;;
  esac
  case "$loc" in
    *scope=*) bad "requests a scope; registration should need none" ;;
    *) ok "requests no scope" ;;
  esac
fi

echo "== callback rejects a forged code =="
# No link-intent cookie, no matching state: must not attempt an exchange.
forged="$(curl -s -o /dev/null -w '%{redirect_url}|%{http_code}' -m 20 \
  "$AUTH/callback?code=forged&state=forged")"
case "$forged" in
  *github=error*|*github=active_trade*) ok "forged callback refused (${forged})" ;;
  "|404")
    bad "skipped — routes are not mounted (see above); re-run once configured" ;;
  *) bad "forged callback was not clearly refused: $forged" ;;
esac

echo
if [ "$fails" -eq 0 ]; then
  echo "All automated checks passed. Remaining: click Sign in on $ORIGIN/bet"
  echo "and confirm the header shows your GitHub handle."
else
  echo "$fails check(s) failed — see above."
fi
exit "$fails"
