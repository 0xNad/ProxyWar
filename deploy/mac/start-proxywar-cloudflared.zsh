#!/bin/zsh
set -euo pipefail

CONFIG_FILE="${PROXYWAR_CLOUDFLARED_CONFIG:-$HOME/.cloudflared/proxywar-beta.yml}"
TUNNEL_NAME="${PROXYWAR_CLOUDFLARE_TUNNEL_NAME:-proxywar-beta}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Cloudflare Tunnel config not found: $CONFIG_FILE" >&2
  echo "Copy deploy/cloudflare-tunnel.yml.example to that path and fill the real tunnel values." >&2
  exit 64
fi

exec cloudflared tunnel --config "$CONFIG_FILE" run "$TUNNEL_NAME"
