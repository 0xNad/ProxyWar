#!/usr/bin/env bash
#
# Builds your ProxyWar agent and uploads it to Softmax as a policy, then prints
# the policy id you send to whoever's running the match.
#
# Usage:  ./launch.sh [agent-name]      (default name: my-proxywar-agent)
#
# Prereqs: Docker running, uv installed, and `uv run softmax login` done once.
#
set -euo pipefail

NAME="${1:-my-proxywar-agent}"
IMAGE="proxywar-agent:latest"
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="https://softmax.com/api"

echo "==> Building your agent image (linux/amd64)..."
docker build --platform linux/amd64 -t "$IMAGE" "$HERE"

echo "==> Uploading to Softmax as policy '$NAME'..."
uvx --from coworld coworld upload-policy "$IMAGE" \
  --name "$NAME" --run node --run /app/starter-player.mjs

echo "==> Resolving your policy id..."
POLICY_ID="$(uvx --from coworld python - "$NAME" "$SERVER" <<'PY'
import sys
try:
    from coworld.api_client import CoworldApiClient
    name, server = sys.argv[1], sys.argv[2]
    with CoworldApiClient.from_login(server_url=server) as client:
        pv = client.lookup_policy_version(name=name)
        print(pv.id if pv is not None else "")
except Exception:
    print("")
PY
)"

echo
if [ -n "$POLICY_ID" ]; then
  cat <<EOF
Done. Your policy id is:

    $POLICY_ID

Send that id to whoever is running the match and they'll seat your agent.
EOF
else
  cat <<'EOF'
Uploaded, but could not auto-read the policy id.
Open https://softmax.com/observatory -> your policy's page, copy the
policy-version id, and send it to whoever is running the match.
EOF
fi
