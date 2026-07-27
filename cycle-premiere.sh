#!/usr/bin/env bash
# Cycle the hosted betting demo onto a fresh live premiere.
#
#   ./cycle-premiere.sh [lead-minutes]
#
# Generates a new controlled-exhibition match, resets the premiere state root,
# admits the match against the public origin, and brings the origin back up on
# it. Prints the URL. Default lead time is 4 minutes: enough for the restart
# plus a browser to be open before trading opens.
#
# This REPLACES whatever premiere was live. The state root is wiped every run,
# which is deliberate - the demo surface shows one live market at a time, and
# a root accumulates unusable admissions after a few cycles otherwise
# (premiere_not_registered, RUNBOOK 13.6). Any in-flight session, position, or
# bankroll on the previous premiere is destroyed with it.
#
# Requires: the origin manageable under the name below, and nothing else
# holding the state root's single-writer lock.
set -euo pipefail

LEAD_MIN="${1:-4}"
ORIGIN="https://bet.proxywar.xyz"
ORIGIN_PORT=8792
PROC_NAME=bet-live
STATE_PARENT="$HOME/.proxywar-bet-live"
STATE_ROOT="$STATE_PARENT/replay-premiere"
STAGING=/tmp/pw-bet-staging
MANIFESTS=/tmp/pw-bet-manifests
ADMIT_IN=/private/tmp/pw-bet-admit
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

RUN_ID="bet-cycle-$(date +%s)"
# prem_ + exactly 20 lowercase alphanumerics. openssl, not `tr </dev/urandom`,
# which exits 141 on SIGPIPE and takes the script down under pipefail.
PREMIERE_ID="prem_$(openssl rand -hex 10)"

restart_origin() {
  if command -v omp >/dev/null 2>&1 && omp hub restart "$PROC_NAME" >/dev/null 2>&1; then
    return 0
  fi
  echo "    !! could not restart '$PROC_NAME' automatically."
  echo "       Bring the origin up yourself on port ${ORIGIN_PORT} with"
  echo "       PROXYWAR_REPLAY_PREMIERE_STATE_ROOT=${STATE_ROOT}, then re-run."
  return 1
}

wait_for_origin() {
  for _ in $(seq 1 40); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
            "http://127.0.0.1:${ORIGIN_PORT}/league" || true)" = "200" ]; then
      return 0
    fi
    sleep 2
  done
  echo "    !! origin did not come back on port ${ORIGIN_PORT}"
  return 1
}

echo "==> generating match bundle ${RUN_ID}"
mkdir -p "$STAGING"
GAME_ENV=dev npx tsx src/scripts/replay-premiere-controlled-exhibition.ts \
  --run-id="$RUN_ID" \
  --private-output-root="$STAGING" \
  --agent-manifest-dir="$MANIFESTS" \
  --served-root="$(pwd)" \
  --served-root="$(pwd)/static" \
  --served-root="$(pwd)/artifacts" \
  --served-root="$(pwd)/docs" \
  --served-root="$(pwd)/examples/external-agent" \
  --brain=planner \
  --disable-alliance-actions \
  --max-steps=200 \
  --turns-per-decision-step=100 \
  --replay-tail-turns=400 \
  --playback-turn-interval-ms=70 >/dev/null 2>&1

BUNDLE="${STAGING}/${RUN_ID}.source.json"
SHA="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"

# Checkpoints land at 35% / 65% of turnCount, matching
# checkpointSequencesForTurnCount in ReplayPremiereLoopCore.ts.
echo "==> writing admission inputs (lead ${LEAD_MIN}m)"
mkdir -p "$ADMIT_IN"
if [ ! -f "$ADMIT_IN/nonce.bin" ]; then
  python3 -c "import os;open('$ADMIT_IN/nonce.bin','wb').write(os.urandom(32))"
  chmod 600 "$ADMIT_IN/nonce.bin"
fi
python3 - "$BUNDLE" "$LEAD_MIN" <<'PY'
import json, sys, datetime
bundle, lead = sys.argv[1], int(sys.argv[2])
d = json.load(open(bundle))
tc = d["replay"]["turnCount"]
now = datetime.datetime.now(datetime.timezone.utc)
iso = lambda x: x.strftime("%Y-%m-%dT%H:%M:%S.000Z")
json.dump({
    "schemaVersion": 1, "eligibilityCheckVersion": "local-dev/v1",
    "externalEmbargoEvidence": [{
        "source": "controlled runner", "scope": "source and outcome",
        "observedAt": iso(now), "verifier": "operator", "embargoConfirmed": True}],
    "externalOutcomeMayBePublic": False, "publicLabel": "premiere",
}, open("/private/tmp/pw-bet-admit/eligibility.json", "w"), indent=2)
json.dump({
    "schemaVersion": 1,
    "title": "Proxy War Live Market - Which AI policy wins?",
    "spoilerNeutralDescription":
        "Four autonomous AI policies compete on Asia. Trade on the outcome while it unfolds.",
    "map": {"id": "Asia", "label": "Asia"},
    "matchFormat": {"id": "ffa-4", "label": "4-seat FFA", "seatCount": 4},
    "scheduledAt": iso(now + datetime.timedelta(minutes=lead)),
    "playbackRate": 1,
    "checkpoints": [
        {"id": "cp_00000001", "sequence": int(tc * 0.35)},
        {"id": "cp_00000002", "sequence": int(tc * 0.65)},
    ],
}, open("/private/tmp/pw-bet-admit/definition.json", "w"), indent=2)
print(f"    turns={tc} duration={tc*d['replay']['turnIntervalMs']/60000:.1f}min")
PY

# The state root must be empty before admitting or the catalog fills with
# unusable records. It also must be 0700, or the server refuses to boot with
# private_state_root_not_private. Stop the origin first: it holds a
# single-writer lock on the root.
echo "==> resetting state root"
if command -v omp >/dev/null 2>&1; then
  omp hub stop "$PROC_NAME" >/dev/null 2>&1 || true
fi
rm -rf "$STATE_PARENT"
mkdir -p "$STATE_ROOT"
chmod 700 "$STATE_PARENT" "$STATE_ROOT"

# Admission's leak audit fetches the PUBLIC origin and needs a 200 from
# /league, so the origin has to be serving before we admit - even though it
# does not yet know about this premiere.
echo "==> bringing origin up for the leak audit"
restart_origin
wait_for_origin

echo "==> admitting ${PREMIERE_ID}"
GAME_ENV=dev PROXYWAR_PUBLIC_URL="$ORIGIN" npx tsx src/scripts/replay-premiere-admit.ts \
  --premiere-id="$PREMIERE_ID" \
  --source-file="$BUNDLE" \
  --expected-source-sha256="$SHA" \
  --private-state-root="$STATE_ROOT" \
  --served-root="$(pwd)" --served-root="$(pwd)/static" --served-root="$(pwd)/artifacts" \
  --served-root="$(pwd)/docs" --served-root="$(pwd)/examples/external-agent" \
  --eligibility-file="$ADMIT_IN/eligibility.json" \
  --definition-file="$ADMIT_IN/definition.json" \
  --deployment-origin="$ORIGIN" \
  --nonce-file="$ADMIT_IN/nonce.bin" >/dev/null 2>&1

# Admission never hot-registers; the catalog is rebuilt at boot.
echo "==> restarting origin onto the new premiere"
restart_origin
wait_for_origin

URL="${ORIGIN}/bet/${PREMIERE_ID}"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$URL" || true)"
echo
echo "    ${URL}"
echo "    http ${CODE} - trading opens in ~${LEAD_MIN}m"
[ "$CODE" = "200" ]
