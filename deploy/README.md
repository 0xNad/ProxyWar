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

3. Install the app wrapper outside `Documents`, then copy the launchd plist
   examples into `~/Library/LaunchAgents/`:

   ```bash
   mkdir -p "$HOME/Library/Application Support/ProxyWar/bin"
   cp deploy/mac/start-proxywar-beta.zsh \
     "$HOME/Library/Application Support/ProxyWar/bin/start-proxywar-beta.zsh"
   chmod 755 \
     "$HOME/Library/Application Support/ProxyWar/bin/start-proxywar-beta.zsh"
   cp deploy/mac/com.proxywar.beta.plist.example ~/Library/LaunchAgents/com.proxywar.beta.plist
   cp deploy/mac/com.proxywar.cloudflared.plist.example ~/Library/LaunchAgents/com.proxywar.cloudflared.plist
   cp deploy/mac/com.proxywar.beta-backup.plist.example ~/Library/LaunchAgents/com.proxywar.beta-backup.plist
   ```

   Replace every `/Users/YOUR_USER/...` placeholder in the copied plist files
   before loading them.

   For an already-loaded beta, do not use `launchctl kickstart -k`. The old
   npm-based launch shape can kill launchd's parent while leaving the actual
   writer alive. First activation of the direct-Node wrapper is a Control-run
   transaction:
   - before merging, editing, or replacing any repo-hosted old wrapper, hash and
     copy the exact live plist and its referenced wrapper to a dated, owner-only
     backup directory;
   - render and lint the candidate plist, and hash both candidate files;
   - capture launchd's PID/PGID, every member's UID, parent, executable, cwd,
     and start identity, plus the Replay Premiere writer-lock PID;
   - `bootout` the old label, TERM only that revalidated PGID, and SIGKILL only
     unchanged captured members if the bounded grace expires;
   - install the wrapper first and plist second with atomic same-directory
     renames, then `bootstrap` and require one direct Node PID, the same writer
     PID, and HTTP 200 from the loopback readiness URL;
   - on any failure, `bootout` the candidate, restore the exact old plist first
     (it points to the untouched old wrapper), restore/remove the candidate
     wrapper second, `bootstrap` the old plist, and recheck its original hashes;
   - call rollback successful only after the restored label has a managed
     PID/PGID, its writer-lock PID is a same-UID descendant in that exact group
     (the explicitly legacy-safe relationship; it need not equal launchd's PID
     for the old npm shape), and the loopback readiness URL returns HTTP 200. If
     any check fails, rollback is still an open incident: preserve backups and
     logs, and do not retry with `kickstart -k`.

   After that one-time activation, use the bounded restart helper:

   ```bash
   node deploy/mac/proxywar-beta-launchd-restart.mjs --dry-run
   node deploy/mac/proxywar-beta-launchd-restart.mjs
   ```

   The helper probes `http://127.0.0.1:8787/league` by default (the repo's
   default `AI_LEAGUE_DEMO_PORT`). If the deployment serves another port, pass
   `--ready-url=http://127.0.0.1:<port>/league` to both commands. Before any
   signal is sent, the current server must answer that URL with HTTP 200;
   `--allow-unready-current` skips only that preflight (for restarting a hung
   server), and the replacement must still pass the same readiness URL.

   The helper fails closed unless the installed plist/wrapper, entire process
   group, direct server PID, writer lock, current-server readiness preflight,
   and loopback readiness all match.

4. Load the app, tunnel, and scheduled backup:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.proxywar.beta.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.proxywar.cloudflared.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.proxywar.beta-backup.plist
   ```

   The macOS app wrapper runs the production process through
   `/usr/bin/caffeinate -s`. While the app is alive and the host is on AC power,
   this keeps the machine and Cloudflare Tunnel online without preventing
   display sleep or changing global power settings.

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
