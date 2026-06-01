# ProxyWar Remote Friends Beta

This guide is for sharing a local ProxyWar beta with trusted friends or
family.

## Recommended Remote Flow

Use the remote helper:

```bash
PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:closed-beta:remote
```

By default this expects `cloudflared` in your `PATH` and opens a temporary
Cloudflare quick tunnel to the local beta server.

Before starting the session, you can run the remote helper check:

```bash
PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:closed-beta:remote -- --check
```

If you already know the public URL or use your own tunnel, check that exact
share URL:

```bash
PROXYWAR_PUBLIC_URL="https://your-beta-url.example" PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:closed-beta:remote -- --check --provider=none
```

When the tunnel prints a temporary public URL, share:

- the tunnel URL ending in `/public`
- the invite code

The helper does not print the invite code.

## Install Cloudflared

On macOS with Homebrew:

```bash
brew install cloudflared
```

Then rerun:

```bash
PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:closed-beta:remote
```

## Use Your Own Tunnel

If you use Tailscale, ngrok, a VPS reverse proxy, or another tunnel, start the
beta server without an automatic tunnel:

```bash
PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:closed-beta:remote -- --provider=none
```

Then point your tunnel at:

```text
http://127.0.0.1:8787
```

For a known public URL, set:

```bash
PROXYWAR_PUBLIC_URL="https://your-beta-url.example" PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:closed-beta:remote -- --provider=none
```

Use the same environment with `npm run agent:public-readiness:strict` as the
final share/no-share gate.

## Same Wi-Fi / LAN

For testers on the same network:

```bash
PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:closed-beta:lan
```

The server prints LAN URLs such as:

```text
http://192.168.1.42:8787/public
```

Share a LAN URL plus the invite code.

## Safety Notes

- There is no built-in default invite code. Always set
  `PROXYWAR_BETA_CODE` before sharing a remote link.
- Use a private code with at least 8 characters.
- Share links only with trusted testers.
- Stop the server when testing is done.
- The remote helper defaults to one active match at a time and rejects extra
  queued Codex jobs, so repeated button clicks do not silently stack long runs.
- Artifact reports can include debugging details and model prompts/responses.
- The beta gate is local invite protection, not production user accounts.
- The demo server has a small in-memory rate limiter for login, job, nation,
  endpoint-check, and feedback requests. It is a local beta safety brake, not a
  substitute for production auth, edge limits, and persistent abuse controls.

## What Works Remotely

- invite-gated beta page
- AI nation creation
- external endpoint agent registration for friends who want to run their own
  agent service
- Codex-planned saved-nations match launcher
- automatic transfer into the rendered ProxyWar replay when a match completes
- saved external agents matched with Codex-powered house agents in the trusted
  beta flow
- varied spawn selection between runs
- recent action feed in the replay overlay, including attacks, builds, target
  calls, quick-chat, emoji, embargoes, and holds
- replay links route through the same beta/tunnel origin, so friends are not
  sent to their own `localhost`
- if a friend opens a replay link before entering the invite code, the beta
  login redirects back to that replay after successful login
- visual reports
- static spectator timeline
- scorecards and match reports
- feedback capture

## Connecting A Friend's Own Agent

Use **Connect With One Link** on the beta page. Paste an Agent Card markdown
URL when the endpoint is already deployed. For local/manual testing, open the
advanced endpoint drawer.

Keep the URLs separate:

- paste `/agent-card.md` into **Connect With One Link**
- paste `/proxywar/decide` into manual **Test Endpoint**
- use `/health` only for liveness/protocol metadata

If the friend uses the starter template, have them keep `npm start` running and
run this before sending you their Agent Card URL:

```bash
npm run self-test
```

The self-test uses the same `selectedLegalActionId` health-check contract as the
beta and gives provider/URL/JSON fixes without needing live operator help.

The friend provides an HTTP endpoint URL. During each decision step the server
sends that endpoint an observation and a list of legal action ids. The endpoint
must return strict JSON:

```json
{
  "selectedLegalActionId": "one-listed-action-id",
  "reason": "Short explanation.",
  "confidence": 0.7
}
```

The endpoint never sends raw game intents. ProxyWar validates the
selected id and still submits through `AgentRunner -> GameServer`. Saved
external endpoints are part of the local saved-nations queue. The beta match can
add Codex-powered house agents when more entrants are needed.

If a bearer token is used in the beta page, ask the friend to paste a beta-only
token or leave the token blank. The local server moves pasted tokens into
`artifacts/proxywar/secrets/` and stores only `tokenSecret` in the manifest.
The browser form and health check do not resolve `env:` or `secret:` references.
Operator-authored local manifest files may still use `tokenEnv`, but that path
is not exposed to remote testers.

Use **Test Endpoint** before saving. This sends a synthetic health-check payload
with `health-check:expand` and `health-check:hold`; the endpoint must select one
of those ids. Passing the check means the endpoint speaks the protocol, not that
it will play well.

For remote friend testing, external agent endpoints should be HTTPS public URLs.
Localhost, LAN, and other private-network endpoint URLs are blocked by default
to protect the host machine. For your own local-only development, you can opt in
explicitly:

```bash
PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS=true PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:closed-beta
```

The default external-agent transport resolves the endpoint, blocks private,
local, and reserved addresses unless that opt-in is set, pins the request to
the resolved address for that call, disables redirects, and caps response size.
If an endpoint fails this policy, the health check and match reports show the
failure reason.

After entering the beta invite code, the operator can inspect queue and endpoint
status at:

```text
/admin
```

The beta page now labels saved entrants as the **Next Match Queue**. The next
saved-roster match uses saved entrants first, then house agents as needed.

Closed beta mode serves only allowlisted artifact names through a path-safe
route. The allowlist includes replay files plus `decisions.jsonl` and
`match-summary.json` because the rendered replay overlay needs them. Treat
those as trusted-tester artifacts, not public anonymous assets.

Full protocol details live in:

```text
/docs/PROXYWAR_EXTERNAL_AGENT_API.md
```

The gated beta page also exposes public-safe copy-paste examples:

```text
/examples/external-agent/README.md
/examples/external-agent/simple-agent.mjs
/examples/external-agent/smoke-test.mjs
/examples/external-agent/AGENT_SKILL.md
```

Before inviting friends to connect their own agents, run the local endpoint
dry run:

```bash
OPENROUTER_API_KEY="paste-your-openrouter-key" npm run agent:external-agent:dry-run
```

That confirms the example LLM-backed HTTP agent, endpoint health check, temporary external
roster, and real match path all work on the host machine.

## Current Remote Limitations

- The rendered ProxyWar view is currently a replay that starts as soon as the
  generated match completes. It is not yet a true live stream of turns while the
  match is still running.
- External endpoint mode is private/testing-only. There is no public account,
  authentication, rating, or anti-abuse layer yet.
- Match jobs are bounded by a local one-at-a-time runner. The remote helper
  rejects extra queued jobs by default so accidental duplicate Codex clicks do
  not stack long runs.
- The visible ProxyWar renderer uses the native replay controls and now
  autoplays at a faster spectator speed, but it may spend a few seconds loading
  before the clock visibly advances.
- Agent communication is currently quick-chat/emoji/target actions.
  Freeform inter-agent chat is a future product milestone.
- Prediction credits/betting are a future UX milestone and should use fictional
  local credits only.
- Jobs run on your machine.
- Job history is local and in-process.
- Feedback is local JSONL.
- There is no per-user account system yet.

## Strategy Rounds

The beta page uses **Strategy rounds** instead of human turns. In each round the
runner pauses match advancement, gives every AI nation a fresh observation and
legal actions, records decisions, submits validated intents, then advances the
game. More rounds means a longer match and more agent decisions before the
rendered replay opens. For a friend-facing Codex test, start with the default
six rounds. Increase the round count only after the first rendered replay opens
successfully.

## Codex CLI Model/Effort

Codex CLI demos can be run with a cheaper model/effort setting:

```bash
AI_LEAGUE_CODEX_MODEL=gpt-5.4 AI_LEAGUE_CODEX_REASONING_EFFORT=medium npm run agent:league-demo:planner:codex-medium
```

For an internal benchmark-style match against built-in nations:

```bash
AI_LEAGUE_CODEX_MODEL=gpt-5.4 AI_LEAGUE_CODEX_REASONING_EFFORT=medium npm run agent:benchmark:bots:full:codex-medium
```

The private-beta house-agent mode uses Codex as the strategic brain while the
server keeps decisions inside the offered LegalAction.id menu.

The friend-facing beta page uses the Codex house-agent path by default. Built-in
OpenFront nations and bots are benchmark opponents, not the default tester-match
framing.

If a Codex match finishes in only a few seconds, treat that as a setup failure,
not a real match. The beta runner now fails Codex jobs visibly when Codex CLI is
missing, not logged in, returns invalid planner JSON, or falls back to the local
planner. The server will automatically use the bundled macOS Codex app binary at
`/Applications/Codex.app/Contents/Resources/codex` when `codex` is not on your
Terminal `PATH`. You can still override it explicitly:

```bash
AI_LEAGUE_CODEX_COMMAND="/Applications/Codex.app/Contents/Resources/codex" PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:closed-beta:remote
```

Existing failed/fallback runs cannot be fixed by refreshing the browser. Start a
new match after the server has the corrected Codex setup.

## Release Candidate Check

Run the public readiness gate before inviting testers:

```bash
PROXYWAR_PUBLIC_URL="https://your-beta-url.example" PROXYWAR_BETA_CODE="make-a-private-code" npm run agent:public-readiness:strict
```

This gate checks saved external-agent endpoints live, not only URL shape. A dead
temporary tunnel should block sharing until the endpoint is re-exposed or the
saved agent is deleted.

The latest beta QA pass verified:

- invite login
- public beta page
- public readiness gate
- Codex job launch through `/api/jobs`
- completed job artifact attachment
- rendered ProxyWar replay route
- AI decision overlay
- replay autoplay and action-feed overlay
- clean replay console in local QA
- visual report and spectator links
- full test suite, lint, and development build

Current readiness notes live in:

```text
artifacts/ai-league-progress/beta-readiness-2026-05-11.md
```
