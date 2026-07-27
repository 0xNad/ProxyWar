#!/usr/bin/env bash
# Cycle the hosted betting demo onto a fresh live premiere.
#
#   ./cycle-premiere.sh [lead-minutes]
#
# Generates a new controlled-exhibition match, admits it against the public
# origin, restarts the origin server, and prints the URL. Default lead time is
# 4 minutes, which is enough for the restart plus a browser to be open before
# trading opens.
#
# Requires the origin server to already be running and reachable at the public
# URL: admission's leak audit fetches https://bet.proxywar.xyz/league and needs
# a 200 back. Start it first (see RUNBOOK), then run this.
set -euo pipefail

LEAD_MIN="${1:-4}"
ORIGIN="https://bet.proxywar.xyz"
STATE_ROOT="$HOME/.proxywar-bet-live/replay-premiere"
STAGING=/tmp/pw-bet-staging
MANIFESTS=/tmp/pw-bet-manifests
ADMIT_IN=/private/tmp/pw-bet-admit
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

SUFFIX="$(date +%s | tail -c 7)"
RUN_ID="bet-cycle-${SUFFIX}"
# premiere id must be prem_ + exactly 20 lowercase alphanumerics
PREMIERE_ID="prem_$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 20)"

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
[ -f "$ADMIT_IN/nonce.bin" ] || {
  python3 -c "import os;open('$ADMIT_IN/nonce.bin','wb').write(os.urandom(32))"
  chmod 600 "$ADMIT_IN/nonce.bin"
}
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
echo "==> restarting origin"
omp hub restart bet-live >/dev/null 2>&1 || \
  echo "    (restart bet-live yourself: the origin must reboot to register it)"
sleep 18

URL="${ORIGIN}/bet/${PREMIERE_ID}"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$URL" || true)"
echo
echo "    ${URL}"
echo "    http ${CODE} — trading opens in ~${LEAD_MIN}m"
[ "$CODE" = "200" ] || {
  echo
  echo "    Not 200. Most likely the state root has accumulated too many"
  echo "    admissions (premiere_not_registered — see RUNBOOK 13.6):"
  echo "      rm -rf ~/.proxywar-bet-live && mkdir -p '${STATE_ROOT}'"
  echo "      chmod 700 ~/.proxywar-bet-live '${STATE_ROOT}'"
  echo "    then restart the origin and re-run this."
  exit 1
}
