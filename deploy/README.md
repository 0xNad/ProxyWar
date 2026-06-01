# ProxyWar Hosted Beta Deploy

This folder contains deployment templates for a small private tester release.
They are intentionally conservative: one Node process, one local replay renderer,
one HTTPS reverse proxy, invite-gated access, and no direct public access to the
renderer process.

## Minimal Hosted Shape

```text
tester browser
-> https://beta.your-domain.example
-> Cloudflare Tunnel, Caddy, or another HTTPS reverse proxy
-> ProxyWar demo hub on 127.0.0.1:8787
-> local replay renderer on 127.0.0.1:9000
```

The demo hub proxies the replay renderer and applies the beta invite gate before
testers can access `/public`, `/api/*`, or replay routes.

## Files

- `proxywar-beta.env.example`: required environment variables.
- `proxywar-beta.service`: systemd service template.
- `Caddyfile.example`: HTTPS reverse-proxy template.
- `cloudflare-tunnel.yml.example`: named Cloudflare Tunnel config.
- `mac/`: launchd service templates and wrapper scripts for a macOS host.

## macOS + Cloudflare Tunnel

Use this for a small macOS-hosted beta:

1. Copy the environment file and edit the real domain and invite code:

   ```bash
   mkdir -p ~/.proxywar
   cp deploy/mac/proxywar-beta.env.example ~/.proxywar/proxywar-beta.env
   ```

2. Create a named Cloudflare Tunnel and route one subdomain:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create proxywar-beta
   cloudflared tunnel route dns proxywar-beta beta.your-domain.example
   cp deploy/cloudflare-tunnel.yml.example ~/.cloudflared/proxywar-beta.yml
   ```

   Edit `~/.cloudflared/proxywar-beta.yml` with the tunnel credentials
   file and the same `beta.your-domain.example` hostname.

3. Copy the launchd plist examples into `~/Library/LaunchAgents/`:

   ```bash
   cp deploy/mac/com.proxywar.beta.plist.example ~/Library/LaunchAgents/com.proxywar.beta.plist
   cp deploy/mac/com.proxywar.cloudflared.plist.example ~/Library/LaunchAgents/com.proxywar.cloudflared.plist
   cp deploy/mac/com.proxywar.beta-backup.plist.example ~/Library/LaunchAgents/com.proxywar.beta-backup.plist
   ```

   Replace every `/Users/YOUR_USER/...` placeholder in the copied plist files
   before loading them.

4. Load the app, tunnel, and scheduled backup:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.proxywar.beta.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.proxywar.cloudflared.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.proxywar.beta-backup.plist
   ```

5. Before sharing the URL, run the readiness gate with the same private env:

   ```bash
   set -a
   source ~/.proxywar/proxywar-beta.env
   set +a
   npm run agent:hosted-beta:readiness -- --require-ready
   npm run agent:hosted-beta:smoke
   npm run agent:hosted-beta:backup
   ```

Share only:

- `https://beta.your-domain.example/public`
- the private invite code
- the Agent Card docs link from the beta page

The tester dashboard is invite-gated at:

```text
https://beta.your-domain.example/tester-dashboard
```

It shows queue status, latest replay, latest feedback, saved external agents,
and on-demand endpoint health through the strict hosted endpoint policy.

Before inviting testers, run:

```bash
npm run agent:hosted-beta:readiness -- --require-ready
npm run agent:hosted-beta:smoke
OPENROUTER_API_KEY="paste-your-openrouter-key" npm run agent:external-agent:dry-run
npm run agent:hosted-beta:backup
```

Set `PROXYWAR_HOUSE_AGENT_BRAIN=planner-codex-cli` for the intended
private-beta flow: tester agents play against Codex-planned house nations. The
server keeps the legal-action boundary, but house-agent strategy is LLM-backed.

Set `PROXYWAR_NATIONS_DIR` to a clean directory outside the repo, for
example `$HOME/.proxywar/nations` on the host. This prevents
old local QA agents with localhost endpoints from being loaded in the hosted
beta. The readiness gate will block sharing if saved external agents use HTTP,
localhost, LAN, private, or reserved hosts.

The readiness command writes durable reports under:

```text
artifacts/proxywar/hosted-beta-readiness/
```

Backups are written to `PROXYWAR_BACKUP_DIR` when configured, otherwise to:

```text
artifacts/proxywar/backups/
```

Backups may include private tester feedback and external-agent bearer-token
secrets. Treat them as sensitive files. The default backup copies tester/runtime
state only; pass `--include-match-artifacts` when you intentionally want to copy
the larger historical replay and tournament archives.
