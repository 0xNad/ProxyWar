# Proxy War Hosted Beta

This is the release checklist for a private tester build focused on the
**Connect your agent** flow.

## Goal

A tester can:

1. open a private HTTPS beta URL
2. enter an invite code
3. paste an Agent Card or external endpoint
4. run the endpoint health check
5. save the agent
6. run a match
7. watch the rendered replay
8. send feedback tied to the run

## Required Pieces

### Frontend

The tester-facing page is:

```text
/public
```

It must show:

- Connect With One Link
- Connect External Agent
- First Agent Checklist
- Next Match Queue
- Run First Match
- Agent feedback and latest replay links

### Hosting And Domain

Use the templates in `deploy/`:

- `deploy/proxywar-beta.env.example`
- `deploy/proxywar-beta.service`
- `deploy/Caddyfile.example`
- `deploy/cloudflare-tunnel.yml.example`
- `deploy/mac/proxywar-beta.env.example`
- `deploy/mac/com.proxywar.beta.plist.example`
- `deploy/mac/com.proxywar.cloudflared.plist.example`
- `deploy/mac/com.proxywar.beta-backup.plist.example`

The hosted shape should be:

```text
https://beta.your-domain.example
-> Cloudflare Tunnel or reverse proxy
-> 127.0.0.1:8787 Proxy War demo hub
-> 127.0.0.1:9000 local replay renderer
```

Do not expose the renderer port directly. The beta hub proxies replay routes and
keeps the invite gate in front of the tester surface.

For a small macOS-hosted beta, prefer a named Cloudflare Tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create proxywar-beta
cloudflared tunnel route dns proxywar-beta beta.your-domain.example
cp deploy/cloudflare-tunnel.yml.example ~/.cloudflared/proxywar-beta.yml
mkdir -p ~/.proxywar
cp deploy/mac/proxywar-beta.env.example ~/.proxywar/proxywar-beta.env
```

Edit both copied files with the real subdomain, tunnel credentials path, backup
path, and invite code. Then install the launchd examples from `deploy/mac/` into
`~/Library/LaunchAgents/`.

### Safety Defaults

For hosted testers:

```bash
PROXYWAR_BETA_ENABLED=true
PROXYWAR_PUBLIC_URL=https://beta.your-domain.example
PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS=false
PROXYWAR_MAX_QUEUED_JOBS=1
PROXYWAR_HOUSE_AGENT_BRAIN=planner-codex-cli
AI_LEAGUE_LLM_PROVIDER=codex-cli
AI_LEAGUE_CODEX_MODEL=gpt-5.4
AI_LEAGUE_CODEX_TRANSPORT=app-server
AI_LEAGUE_CODEX_APP_SERVER_IDLE_CLOSE_MS=1800000
AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS=true
PROXYWAR_EXTERNAL_AGENT_DECISION_TIMEOUT_MS=15000
PROXYWAR_AGENT_RELAY_ACTIVE_IDLE_MS=90000
PROXYWAR_BACKUP_DIR=/var/backups/proxywar
PROXYWAR_NATIONS_DIR=/var/lib/proxywar/nations
```

The tester-facing beta match default is locked to the latest saved tester
external agent plus one in-house Codex agent using ChatGPT mini 5.4 (`gpt-5.4`)
against two Easy built-in nations until a winner emerges. `maxSteps=700` is an
operator fail-safe intended to reach the core game's forced-winner timer; do not
present the fail-safe as the match objective. Change the roster, model, or Easy
built-in nation default only after an explicit operator request.

Hosted matches cap external tester-agent decisions separately from the Codex
house-agent budget. Set `PROXYWAR_EXTERNAL_AGENT_DECISION_TIMEOUT_MS` if needed;
the default is `15000`, so a stuck local Claude/Codex/custom command falls back
fast enough for a full game to keep moving.

Managed relay liveness requires recent worker polling. The default
`PROXYWAR_AGENT_RELAY_ACTIVE_IDLE_MS=90000` gives the relay worker three normal
long-poll windows before readiness/pre-run checks treat the saved relay as
inactive.

External agent endpoints must be public HTTPS URLs. Localhost, LAN, private, and
reserved network addresses are blocked by default.

Use a clean production `PROXYWAR_NATIONS_DIR` outside the repo. This keeps
old local QA agents, localhost endpoints, and throwaway manifests out of the
hosted beta roster. The readiness gate blocks public sharing if any saved
external agent still points at HTTP, localhost, LAN, private, or reserved hosts.

`planner-codex-cli` means the house nations use Codex CLI as the strategic
brain. The server still enforces that final actions are existing
`LegalAction.id` choices, but the house-agent strategy is not a local rule bot.
This is the intended private-beta mode.

For hosted beta, `AI_LEAGUE_CODEX_TRANSPORT=app-server` is the intended Codex
subscription path. It keeps one long-lived `codex app-server --listen stdio://`
worker alive across match decisions and avoids starting Codex CLI for every
decision. The default `AI_LEAGUE_CODEX_APP_SERVER_IDLE_CLOSE_MS=1800000` keeps
the worker alive across realistic match gaps, and the match script closes it at
completion. This does not reduce LLM call frequency or move traffic to a paid
API key path. Use `AI_LEAGUE_CODEX_TRANSPORT=exec` only as a rollback.

### Send/No-Send Gate

Send the beta link only when all of these pass on the hosted machine:

- `PROXYWAR_PUBLIC_URL` is the real HTTPS beta URL.
- `PROXYWAR_BETA_CODE` is set to the invite code you will send.
- `PROXYWAR_MAX_QUEUED_JOBS=1`.
- `PROXYWAR_BACKUP_DIR` points to a writable backup directory.
- `npm run agent:hosted-beta:readiness -- --require-ready` exits 0.
- `npm run agent:hosted-beta:smoke` exits 0.
- `npm run agent:saved-agents:health` reports no failed saved external HTTP
  agents when HTTP Agent Cards are in use.

Treat any failed readiness, smoke, or saved-agent health check as **NO-SEND**.
Do not send the tester link while a saved external agent points at a dead
tunnel, a local/private URL, a placeholder domain, or a service that cannot pass
the health check.

When `PROXYWAR_PUBLIC_URL` and the invite code are configured,
`agent:hosted-beta:readiness` logs into the live hosted URL and reads
`/api/public-readiness`. That live check is authoritative for managed relay
agents because relay sessions are process-local and cannot be proven by the
offline saved-agent file scanner alone. A still-running relay worker can
reattach after a beta-server restart when it polls with the saved token, but the
live checks still require recent worker activity.

If readiness or saved-agent health fails, use one of these fixes before sharing:

- restart or re-expose the external agent endpoint, then retry the health check
- delete and re-import the tester's Agent Card
- for managed relay agents, ask the tester to rerun `/agent-start.sh` so a
  fresh relay session becomes the newest saved agent
- use `npm run agent:saved-agents:health -- --archive-failed` only after you
  decide the stale HTTP saved agent should not be revived

### Validation

Before inviting testers, run:

```bash
npm run agent:saved-agents:health
npm run agent:hosted-beta:readiness -- --require-ready
npm run agent:hosted-beta:smoke
OPENROUTER_API_KEY="paste-your-openrouter-key" npm run agent:external-agent:dry-run
npm run agent:hosted-beta:backup
```

The readiness command checks:

- invite gate
- HTTPS public URL
- secure beta cookie
- private endpoint lock
- saved external-agent URL policy, live HTTP endpoint health, and live managed
  relay session health through the hosted `/api/public-readiness` route
- Codex-powered house-agent brain
- Codex CLI command availability
- external tester-agent decision timeout
- rendered replay availability
- showcase availability
- artifact allowlist
- queue limit
- rate limits
- writable artifacts/jobs/feedback/secrets
- backup directory
- deployment templates
- rollback metadata

If readiness blocks on a stale saved external endpoint, inspect saved agents:

```bash
npm run agent:saved-agents:health
```

The command is a dry run unless `-- --archive-failed` is supplied. It is useful
for HTTP Agent Card endpoints. For managed relay agents, the live
`/api/public-readiness`, hosted readiness, hosted smoke, and tester-dashboard
endpoint health checks are the authoritative session-liveness gates.

The smoke command checks the real `PROXYWAR_PUBLIC_URL` over HTTPS. It logs
in through the invite gate, loads `/public`, `/agent-start`, `/agent-start.json`,
`/tester-dashboard`, `/api/public-readiness`, and the latest rendered replay
route. Add `-- --run-match` only when you intentionally want the smoke test to
queue the locked full winner-required hosted match and wait for a rendered replay.

The invite-gated tester dashboard is:

```text
/tester-dashboard
```

It shows queue status, latest replay, feedback links, saved external agents, and
an on-demand endpoint health check that uses the same strict hosted endpoint
policy as real matches.

The strict readiness gate will not pass with placeholder domains. Set
`PROXYWAR_PUBLIC_URL` to the real HTTPS beta URL before using
`--require-ready`.

### Backups

Default backups include:

- job history
- saved nations
- active roster
- tester feedback
- external-agent bearer-token secrets
- rate-limit snapshot

Historical match runs and tournament archives can become very large. Include
them only for an intentional archival snapshot:

```bash
npm run agent:hosted-beta:backup -- --include-match-artifacts
```

Backups may contain private tester data and secrets. Store them as sensitive
operator-only files.

### Rollback

The rollback path is Git-based:

```bash
git log --oneline -5
git switch main
git reset --hard <known-good-commit>
npm run agent:hosted-beta:readiness -- --require-ready
```

Use this only on the hosted deployment checkout. Do not run destructive Git
commands in the development workspace unless explicitly intended.

## Tester Packet

Send testers:

- the beta URL
- the invite code
- `docs/PROXYWAR_EXTERNAL_AGENT_API.md`
- `examples/external-agent/PROXYWAR_AGENT_CARD.md`
- `examples/external-agent/simple-agent.mjs`
- `examples/external-agent/bootstrap.sh`
- `examples/external-agent/AGENT_SKILL.md`

Do not send operator secrets, deployment env files, or backup files.
