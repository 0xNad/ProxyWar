# Open Frontier Hosted Beta Deploy

This folder contains deployment templates for a small private tester release.
They are intentionally conservative: one Node process, one local replay renderer,
one HTTPS reverse proxy, invite-gated access, and no direct public access to the
renderer process.

## Minimal Hosted Shape

```text
tester browser
-> https://beta.your-domain.example
-> Cloudflare Tunnel, Caddy, or another HTTPS reverse proxy
-> Open Frontier demo hub on 127.0.0.1:8787
-> local replay renderer on 127.0.0.1:9000
```

The demo hub proxies the replay renderer and applies the beta invite gate before
testers can access `/public`, `/api/*`, or replay routes.

## Files

- `open-frontier-beta.env.example`: required environment variables.
- `open-frontier-beta.service`: systemd service template.
- `Caddyfile.example`: HTTPS reverse-proxy template.
- `cloudflare-tunnel.yml.example`: named Cloudflare Tunnel config.
- `mac/`: launchd service templates and wrapper scripts for a macOS host.

## macOS + Cloudflare Tunnel

Use this for a small macOS-hosted beta:

1. Copy the environment file and edit the real domain and invite code:

   ```bash
   mkdir -p ~/.open-frontier
   cp deploy/mac/open-frontier-beta.env.example ~/.open-frontier/open-frontier-beta.env
   ```

2. Create a named Cloudflare Tunnel and route one subdomain:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create open-frontier-beta
   cloudflared tunnel route dns open-frontier-beta beta.your-domain.example
   cp deploy/cloudflare-tunnel.yml.example ~/.cloudflared/open-frontier-beta.yml
   ```

   Edit `~/.cloudflared/open-frontier-beta.yml` with the tunnel credentials
   file and the same `beta.your-domain.example` hostname.

3. Copy the launchd plist examples into `~/Library/LaunchAgents/`:

   ```bash
   cp deploy/mac/com.openfrontier.beta.plist.example ~/Library/LaunchAgents/com.openfrontier.beta.plist
   cp deploy/mac/com.openfrontier.cloudflared.plist.example ~/Library/LaunchAgents/com.openfrontier.cloudflared.plist
   cp deploy/mac/com.openfrontier.beta-backup.plist.example ~/Library/LaunchAgents/com.openfrontier.beta-backup.plist
   ```

   Replace every `/Users/YOUR_USER/...` placeholder in the copied plist files
   before loading them.

4. Load the app, tunnel, and scheduled backup:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openfrontier.beta.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openfrontier.cloudflared.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openfrontier.beta-backup.plist
   ```

5. Before sharing the URL, run the readiness gate with the same private env:

   ```bash
   set -a
   source ~/.open-frontier/open-frontier-beta.env
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

Set `OPEN_FRONTIER_HOUSE_AGENT_BRAIN=planner-codex-cli` for the intended
private-beta flow: tester agents play against Codex-planned house nations. The
server keeps the legal-action boundary, but house-agent strategy is LLM-backed.

Set `OPEN_FRONTIER_NATIONS_DIR` to a clean directory outside the repo, for
example `$HOME/.open-frontier/nations` on the host. This prevents
old local QA agents with localhost endpoints from being loaded in the hosted
beta. The readiness gate will block sharing if saved external agents use HTTP,
localhost, LAN, private, or reserved hosts.

The readiness command writes durable reports under:

```text
artifacts/open-frontier/hosted-beta-readiness/
```

Backups are written to `OPEN_FRONTIER_BACKUP_DIR` when configured, otherwise to:

```text
artifacts/open-frontier/backups/
```

Backups may include private tester feedback and external-agent bearer-token
secrets. Treat them as sensitive files. The default backup copies tester/runtime
state only; pass `--include-match-artifacts` when you intentionally want to copy
the larger historical replay and tournament archives.
