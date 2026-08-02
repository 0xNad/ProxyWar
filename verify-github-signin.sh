#!/usr/bin/env bash
# Verify GitHub sign-in end to end on the hosted PLATFORM deploy.
#
#   ./verify-github-signin.sh
#   PW_PLATFORM_ORIGIN=https://app.proxywar.xyz ./verify-github-signin.sh   # the pre-cutover alias
#
# Run this after registering the OAuth App against the platform origin and
# writing the two credential files (RUNBOOK.md 16.2). It checks everything
# reachable without a browser: credentials present and correctly permissioned,
# routes mounted, the authorize redirect well-formed, and the callback refusing
# forged requests.
#
# Identity is NOT a betting feature any more: sign-in lives only on the
# platform origin, under /api/auth/github/*, and betting reaches it through a
# one-time handoff code (RUNBOOK.md 16.1). This script used to point at
# bet.proxywar.xyz/api/premieres/auth/github — that surface is gone.
#
# The one thing it cannot check is a human clicking "Authorize" on github.com.
# Everything up to and after that is covered here.
set -uo pipefail

# The platform origin doubles as the expected `redirect_uri` host: the router
# builds the callback from its own configured origin, and the OAuth App has
# exactly one registered callback, so these cannot legitimately differ. Nothing
# below hardcodes a host — override this one variable to probe another origin.
# The apex became canonical on 2026-07-30 (RUNBOOK.md 16.2); app.proxywar.xyz
# now 302s here, so pointing this at the alias would only ever verify the
# redirect.
ORIGIN="${PW_PLATFORM_ORIGIN:-https://proxywar.xyz}"
ID_FILE="${PW_GITHUB_CLIENT_ID_FILE:-$HOME/.proxywar-deploy/github-oauth-client-id}"
SECRET_FILE="${PW_GITHUB_CLIENT_SECRET_FILE:-$HOME/.proxywar-deploy/github-oauth-client-secret}"
AUTH="$ORIGIN/api/auth/github"
EXPECTED_CALLBACK="$ORIGIN/api/auth/github/callback"
fails=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails + 1)); }
note() { printf '       %s\n' "$1"; }

# Percent-encode for comparison against the `redirect_uri=` query parameter.
urlencode() {
  local raw="$1" out="" i char
  for ((i = 0; i < ${#raw}; i++)); do
    char="${raw:i:1}"
    case "$char" in
      [a-zA-Z0-9.~_-]) out+="$char" ;;
      *) out+="$(printf '%%%02X' "'$char")" ;;
    esac
  done
  printf '%s' "$out"
}

# Every account route rejects a request that cannot prove same-origin: no
# Origin, no Sec-Fetch-Site, no matching Referer means `assertReadOrigin`
# throws and the route fails closed (PlatformAccountSecurity). A bare curl is
# not a browser, so send what a same-origin browser navigation sends —
# otherwise this script would report a working deploy as broken.
same_origin_get() {
  curl -s -m 20 -H "Sec-Fetch-Site: same-origin" "$@"
}

echo "== origin =="
note "$ORIGIN"

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
# Absent credentials mean the router is never mounted, and the platform runs in
# league-wrapper mode: an unmounted path 302s to /league rather than 404ing.
# Treat both as "absent" — the distinction is a routing detail, not a state.
status_probe="$(same_origin_get -o /dev/null -w '%{http_code}|%{redirect_url}' "$AUTH/status")"
status_code="${status_probe%%|*}"
status_target="${status_probe#*|}"
case "$status_code" in
  200) ok "status route mounted (200)" ;;
  404) bad "routes absent (status -> 404)"
       note "credentials unreadable at boot, or the origin has not restarted since."
       note "restart the platform (launchctl kickstart -k gui/\$UID/com.proxywar.platform), then re-run." ;;
  302|301)
       bad "routes absent (status -> $status_code ${status_target:-/league})"
       note "the league wrapper swallowed the path, so the OAuth router was never mounted:"
       note "credentials unreadable at boot, or the origin has not restarted since."
       note "restart the platform (launchctl kickstart -k gui/\$UID/com.proxywar.platform), then re-run." ;;
  503) bad "status route returned 503 — router mounted, account authority unhealthy"
       note "check /tmp/pw-platform.log for platform_github_auth_status_failed" ;;
  *)   bad "status route returned $status_code" ;;
esac

echo "== authorize redirect =="
loc="$(same_origin_get -o /dev/null -w '%{redirect_url}' "$AUTH/start")"
if [ -z "$loc" ]; then
  bad "start did not redirect"
elif [ "$loc" = "$ORIGIN/league" ]; then
  # The league wrapper's catch-all, i.e. the router was never mounted. One
  # failure, not five: the sub-assertions below would each restate it.
  bad "start is unmounted (-> $loc); nothing to assert about the authorize URL"
elif [ "${loc#"$ORIGIN"/account}" != "$loc" ]; then
  # start fails closed to /account?github=error rather than leaking why.
  bad "start bounced back to the account page instead of GitHub: $loc"
  note "routes absent, or bootstrapRead rejected the request's origin."
else
  case "$loc" in
    https://github.com/login/oauth/authorize\?*) ok "redirects to github authorize" ;;
    *) bad "unexpected redirect target: $loc" ;;
  esac
  encoded_callback="$(urlencode "$EXPECTED_CALLBACK")"
  case "$loc" in
    *"redirect_uri=$encoded_callback"*)
      ok "callback matches this origin ($EXPECTED_CALLBACK)" ;;
    *) bad "callback in the redirect is not $EXPECTED_CALLBACK"
       note "the OAuth App has ONE registered callback; PROXYWAR_PLATFORM_ORIGIN must equal it"
       note "$loc" ;;
  esac
  case "$loc" in
    *client_id=*) ok "carries a client id" ;;
    *) bad "no client_id parameter" ;;
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
forged="$(same_origin_get -o /dev/null -w '%{redirect_url}|%{http_code}' \
  "$AUTH/callback?code=forged&state=forged")"
case "$forged" in
  *"/account?github=error"*) ok "forged callback refused (${forged})" ;;
  "|404"|*"/league|302"*|*"/league|301"*)
    bad "skipped — routes are not mounted (see above); re-run once configured" ;;
  *) bad "forged callback was not clearly refused: $forged" ;;
esac

echo
if [ "$fails" -eq 0 ]; then
  cat <<DONE
All automated checks passed — everything reachable without a browser is good.

What is NOT yet proven, and cannot be from here: whether the OAuth App's
registered callback really is $EXPECTED_CALLBACK on github.com's side. The
authorize redirect only proves what this server ASKS for; a mismatch surfaces
as GitHub's own "redirect_uri is not associated with this application" page,
never as a failure here.

That needs one human authorization, because no automated agent can (or should)
type your GitHub credentials:

  1. Open $ORIGIN/account and click "Sign in with GitHub".
  2. Complete the GitHub login and click Authorize.
  3. Confirm the page then shows your GitHub handle.

If you would rather someone else verify the callback, linking and merge
behaviour, leave that authenticated browser session open and attachable and
they can pick it up from step 3.
DONE
else
  echo "$fails check(s) failed — see above."
fi
exit "$fails"
