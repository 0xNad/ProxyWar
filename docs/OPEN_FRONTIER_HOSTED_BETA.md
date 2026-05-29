# Open Frontier Hosted Beta

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

- `deploy/open-frontier-beta.env.example`
- `deploy/open-frontier-beta.service`
- `deploy/Caddyfile.example`
- `deploy/cloudflare-tunnel.yml.example`
- `deploy/mac/open-frontier-beta.env.example`
- `deploy/mac/com.openfrontier.beta.plist.example`
- `deploy/mac/com.openfrontier.cloudflared.plist.example`
- `deploy/mac/com.openfrontier.beta-backup.plist.example`

The hosted shape should be:

```text
https://beta.your-domain.example
-> Cloudflare Tunnel or reverse proxy
-> 127.0.0.1:8787 Open Frontier demo hub
-> 127.0.0.1:9000 local replay renderer
```

Do not expose the renderer port directly. The beta hub proxies replay routes and
keeps the invite gate in front of the tester surface.

For a small macOS-hosted beta, prefer a named Cloudflare Tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create open-frontier-beta
cloudflared tunnel route dns open-frontier-beta beta.your-domain.example
cp deploy/cloudflare-tunnel.yml.example ~/.cloudflared/open-frontier-beta.yml
mkdir -p ~/.open-frontier
cp deploy/mac/open-frontier-beta.env.example ~/.open-frontier/open-frontier-beta.env
```

Edit both copied files with the real subdomain, tunnel credentials path, backup
path, and invite code. Then install the launchd examples from `deploy/mac/` into
`~/Library/LaunchAgents/`.

### Safety Defaults

For hosted testers:

```bash
OPEN_FRONTIER_BETA_ENABLED=true
OPEN_FRONTIER_PUBLIC_URL=https://beta.your-domain.example
OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS=false
OPEN_FRONTIER_MAX_QUEUED_JOBS=1
OPEN_FRONTIER_HOUSE_AGENT_BRAIN=planner-codex-cli
AI_LEAGUE_LLM_PROVIDER=codex-cli
AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS=true
OPEN_FRONTIER_BACKUP_DIR=/var/backups/open-frontier
OPEN_FRONTIER_NATIONS_DIR=/var/lib/open-frontier/nations
```

External agent endpoints must be public HTTPS URLs. Localhost, LAN, private, and
reserved network addresses are blocked by default.

Use a clean production `OPEN_FRONTIER_NATIONS_DIR` outside the repo. This keeps
old local QA agents, localhost endpoints, and throwaway manifests out of the
hosted beta roster. The readiness gate blocks public sharing if any saved
external agent still points at HTTP, localhost, LAN, private, or reserved hosts.

`planner-codex-cli` means the house nations use Codex CLI as the strategic
brain. The server still enforces that final actions are existing
`LegalAction.id` choices, but the house-agent strategy is not a local rule bot.
This is the intended private-beta mode.

### Validation

Before inviting testers, run:

```bash
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
- saved external-agent endpoint safety
- Codex-powered house-agent brain
- Codex CLI command availability
- rendered replay availability
- showcase availability
- artifact allowlist
- queue limit
- rate limits
- writable artifacts/jobs/feedback/secrets
- backup directory
- deployment templates
- rollback metadata

The smoke command checks the real `OPEN_FRONTIER_PUBLIC_URL` over HTTPS. It logs
in through the invite gate, loads `/public`, `/agent-start`, `/agent-start.json`,
`/tester-dashboard`, `/api/public-readiness`, and the latest rendered replay
route. Add `-- --run-match` when you intentionally want the smoke test to queue
a short hosted match and wait for a rendered replay.

The invite-gated tester dashboard is:

```text
/tester-dashboard
```

It shows queue status, latest replay, feedback links, saved external agents, and
an on-demand endpoint health check that uses the same strict hosted endpoint
policy as real matches.

The strict readiness gate will not pass with placeholder domains. Set
`OPEN_FRONTIER_PUBLIC_URL` to the real HTTPS beta URL before using
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
- `docs/OPEN_FRONTIER_EXTERNAL_AGENT_API.md`
- `examples/external-agent/OPEN_FRONTIER_AGENT_CARD.md`
- `examples/external-agent/simple-agent.mjs`
- `examples/external-agent/AGENT_SKILL.md`

Do not send operator secrets, deployment env files, or backup files.
