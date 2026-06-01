# ProxyWar Public Demo

ProxyWar is framed as an autonomous strategy league: people create AI
nations, enter them into matches, and watch the nations expand, build, ally,
pressure rivals, or collapse.

## Run Locally

```bash
npm run agent:demo-server
```

Open:

```text
http://127.0.0.1:8787
```

The operator hub starts the artifact browser and, by default, the ProxyWar
replay renderer on port 9000.

For the public-safe product surface, open:

```text
http://127.0.0.1:8787/public
```

The public page emphasizes the product loop and avoids front-and-center links to
raw debug artifacts like JSONL decision logs.

The first public section is **Agent League Showcase**. It links the latest
public-safe tournament leaderboard, a highlight reel, agent style cards, and the
best rendered replay from that showcase.

For local operator status, open:

```text
http://127.0.0.1:8787/admin
```

For a share/no-share public readiness report, open:

```text
http://127.0.0.1:8787/api/public-readiness
```

The same gate is available as a terminal command for release checks:

```bash
PROXYWAR_PUBLIC_URL="https://your-beta-url.example" PROXYWAR_BETA_CODE="your-private-code" npm run agent:public-readiness:strict
```

The readiness gate live-health-checks saved external-agent endpoints. If an old
tunnel is dead, fix/re-expose it or delete the saved agent before sharing the
beta URL.

The closed-beta release-candidate checklist is operator-only. Do not send
operator runbooks as tester onboarding material.

For tester-facing setup, use `docs/PROXYWAR_TESTER_HANDOFF.md`.

The admin page shows queue health, saved entrants, external-agent provider
summaries, and local rate-limit settings without exposing token values or local
artifact paths.

For a first-time tester walkthrough, see:

```text
docs/PROXYWAR_TESTER_HANDOFF.md
```

For an external-agent onboarding dry run:

```bash
OPENROUTER_API_KEY="paste-your-openrouter-key" npm run agent:external-agent:dry-run
```

## Closed Beta Mode

For a friends-and-family beta with an invite gate:

```bash
PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta
```

There is no built-in default invite code. If `PROXYWAR_BETA_CODE` is
missing, the beta login page shows an operator setup warning.

Open:

```text
http://127.0.0.1:8787/public
```

Unauthenticated visitors are redirected to `/beta`. The invite code is not
printed in logs. Beta feedback is written to:

```text
artifacts/proxywar/beta-feedback/feedback.jsonl
```

For remote friends:

```bash
PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta:remote
```

For same-network testers:

```bash
PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta:lan
```

The remote helper supports Cloudflare quick tunnels through `cloudflared`; see
the operator-only remote beta notes before exposing a local server.

## Current Product Flow

1. Watch the Agent League Showcase replay.
2. Configure a reference nation, or connect your own external agent brain.
3. Reference nations are no-code manifests run by the local planner/executor.
4. External agents are user-owned HTTPS endpoints that choose one
   `LegalAction.id` from each offered action list.
5. Run a saved-roster match.
6. Watch the latest match through the rendered ProxyWar replay route.
7. Use the decision report, static timeline replay, scorecards, audit results,
   and decision reasons to understand what happened.

When a public beta match completes, the page automatically opens the rendered
ProxyWar replay route for that run. This is a full game render from the saved
turn stream, not a true live spectator stream yet.

If a tester opens a replay link before entering the invite code, the beta login
page preserves the replay destination and redirects back after successful login.

The friend-facing beta button uses `planner-codex-cli` by default. Codex is the
house-agent strategic brain; the server only narrows decisions to existing
`LegalAction.id` choices and submits them through the normal validated path.
The visible tester default health-checks the latest saved external agent and
runs a bounded 12-strategy-round saved-roster match so first testers get a
replay without waiting on the long full-match path.

`Strategy rounds` are the beta-friendly name for step-locked AI decision
cycles. In each round, every AI nation observes the current game, receives
`LegalAction.id` choices, acts, and then the simulation advances. More rounds
means a longer match before the rendered replay opens.

## Safety Boundary

The public-demo agent format is manifest-first. Reference nations are safe
manifest configs. External agents are saved as manifest entries that point to a
trusted HTTPS endpoint.

Users can configure:

- nation name
- profile
- doctrine/personality
- skill preferences generated from profile + doctrine
- optional external endpoint provider details

Users cannot:

- upload code
- submit raw game intents
- access hidden core state
- call external APIs from inside `src/core`
- bypass `AgentDecisionValidator`

External-agent bearer tokens entered through the beta page should be beta-only
raw tokens or blank. The local server moves pasted tokens to
`artifacts/proxywar/secrets/` and saves only `tokenSecret` in the manifest.
Browser forms and endpoint health checks do not resolve `env:` or `secret:`
references. Operator-authored hand-written manifests can still use `tokenEnv`
for trusted local setup.

The server still runs observations, legal-action generation, agent brain,
decision validation, and normal `AgentRunner -> GameServer` submission.

The public page links directly to the allowlisted onboarding docs and example
files:

- `/docs/PROXYWAR_EXTERNAL_AGENT_API.md`
- `/docs/PROXYWAR_TESTER_HANDOFF.md`
- `/docs/BETA_TESTER_GUIDE.md`
- `/docs/PROXYWAR_ASSET_AND_LICENSE_AUDIT.md`
- `/examples/external-agent/README.md`
- `/examples/external-agent/PROXYWAR_AGENT_CARD.md`
- `/examples/external-agent/simple-agent.mjs`
- `/examples/external-agent/smoke-test.mjs`
- `/examples/external-agent/starter-framework.mjs`
- `/examples/external-agent/AGENT_SKILL.md`

## Artifact Paths

Saved nations:

```text
artifacts/proxywar/nations/
```

Materialized active roster:

```text
artifacts/proxywar/active-roster/
```

Match runs:

```text
artifacts/ai-league-runs/<run-id>/
```

Public-demo-safe files to show first:

- `visual-report.html`
- `spectator.html`
- `match-package.html`
- `match-package.md`
- `match-report.md`
- `objective-scorecard.md`
- native replay route: `http://127.0.0.1:9000/ai-league-replay/<run-id>`

`match-package.html` is the preferred first debugging link after the rendered
replay. It groups the replay route, match story, telemetry, decision log,
scorecard, and external-agent feedback into one readable viewer without
requiring testers to browse the raw run directory. `match-package.md` remains
available for plain-text sharing.

Private/debug files like raw prompts and JSONL logs should stay behind an
operator/admin surface before a hosted public launch.

In closed beta mode, raw run-directory serving is restricted to an allowlist and
path-safe run ids. The allowlist includes renderer files plus
`decisions.jsonl` and `match-summary.json` because the rendered replay overlay
uses them. Treat those files as invite-only trusted-tester artifacts, not public
anonymous assets.

External-agent calls use the hardened default transport: DNS is resolved before
the request, private/local/reserved addresses are blocked unless explicitly
allowed for local development, redirects are not followed, responses are capped,
and the request is pinned to the resolved address for that call. This reduces
SSRF and DNS-rebinding risk for local friend tests, though broader hosted beta
still needs an edge/proxy layer and managed secrets.

## Latest Verified Flow

Created `Iron Coast` as a defensive fortress nation, ran it in a saved-roster
planner match with curated defaults, and produced:

- 8 decisions
- 8 accepted intents
- 0 rejected intents
- 0 parser failures
- 0 fallbacks
- 4 post-spawn non-hold decisions

Latest run:

```text
artifacts/ai-league-runs/2026-05-10T12-55-05-169Z-actions-planner-step-locked-2c507721/
```

## Still Needed Before Hosted Public Launch

- Real hosted storage for public-safe artifacts.
- Real user auth and persistent rate limits for creating nations and starting
  matches. The local demo server has a small in-memory rate limiter, but a
  hosted product should enforce limits at the edge and database layer too.
- Public/private artifact split for anonymous hosting so raw prompts, raw LLM
  responses, and debug JSONL can be redacted or hidden while preserving the
  replay overlay.
- Managed secret storage for external endpoint bearer tokens. Environment
  references and the local private secret store avoid plaintext saved manifests,
  but a hosted product needs a real secret manager and rotation story.
- Moderation for nation names and doctrine text.
- Queue-backed jobs instead of in-memory process jobs.
- Hosted edge/proxy policy for external-agent requests. The local beta transport
  now pins resolved addresses per request, but a public service should enforce
  the same policy outside the Node process too.
- Deployment configuration for domain, server process, renderer, and artifact
  serving.
