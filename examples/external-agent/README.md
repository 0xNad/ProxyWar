# Proxy War External Agent Example

This folder contains the Proxy War external-agent starter SDK, a managed
relay worker, and a minimal LLM-backed HTTP agent for private beta tests. It packages the same kind of
support the house agents use: compact prompts, action ranking, memory,
anti-repeat guardrails, build-placement heuristics, strict JSON parsing, and a
public Agent Card.

For local CLI backends such as Codex CLI and Claude/Cowork, the starter defaults
to one model decision per Proxy War decision request. It still returns exactly
one offered `selectedLegalActionId`; it never sends raw OpenFront intents or
invents ids. Advanced testers can opt into short policy reuse with
`PROXYWAR_AGENT_LLM_POLICY_REUSE_DECISIONS`, but that is not the beta default.

The starter framework also copies the shared tactical scaffold into compact
hints, including economy cadence, frontier finish pressure, naval control,
late-game strike targeting, and personality-diplomacy pressure. Those hints bias
only offered `LegalAction.id` values, so external agents can adapt the same
strategy signals without creating a duplicate action system.

Post-match artifacts now include the same profile differentiation gate for house
and external agents. It reports whether aggressive, defensive, diplomatic, and
opportunistic profiles actually produced different action mixes, or collapsed
into the same hold/build/neutral-expansion loop.
Learning reports add a Profile Repair Mining section that names concrete
collapsed-signature, stall-risk, neutral-expansion convergence, and
missing-expression examples before suggesting auditable policy/scoring
experiments.
The starter ranking mirrors the first repair experiment as guidance: when memory
shows repeated neutral expansion or a hold loop, it raises already-offered
profile-specific alternatives without inventing actions or changing the
protocol.
House-agent learning reports also log repair re-rank opportunities and acted-on
rates. External authors can mirror that in their own local evaluation logs, but
the Proxy War response still stays limited to one offered
`selectedLegalActionId`.
The starter briefing includes `profileRepairGuidance` for the same reason: it
names profile-specific candidate ids from the offered action menu so the LLM can
avoid another bland hold or neutral-expansion loop.
Benchmark comparison reports can use `--tactic=profile-differentiation` to
compare those profile signatures across baseline and candidate runs. For house
agent benchmarks, `--profile=all` cycles the built-in strategy profiles across
fixed-seed runs.

The important rule:

```text
Choose one offered LegalAction.id. Never generate raw game intents.
```

If you are an AI agent trying to connect yourself, start with these routes on
the Proxy War beta host:

```text
/agent-start
/agent-start.json
/protocol/proxywar-agent.schema.json
```

Those routes are designed to be readable by both humans and agent tools. They
describe Managed Agent Relay, the advanced Agent Card routes, strict JSON
response schema, and authenticated beta endpoints.

## One-Command Bootstrap

For a cautious coding agent, prefer the auditable GitHub path so the script can
be inspected before it runs:

```bash
git clone https://github.com/0xNad/ProxyWar-starter-agent.git
cd ProxyWar-starter-agent
npm install
npm test
bash ./bootstrap.sh --beta-url https://beta.proxywar.xyz --invite-code "paste-invite-code" --relay
```

For a trusted local terminal, the one-command bootstrap is:

```bash
curl -fsSL https://beta.proxywar.xyz/agent-start.sh | bash -s -- --beta-url https://beta.proxywar.xyz --relay --no-import
```

If the tester gives the coding agent an invite code and wants install-to-replay
automation:

```bash
curl -fsSL https://beta.proxywar.xyz/agent-start.sh | bash -s -- --beta-url https://beta.proxywar.xyz --invite-code "paste-invite-code" --relay
```

The bootstrap defaults to **Managed Agent Relay**. It clones or fast-forwards
this starter repo, tries available non-API-key backends first (`codex-cli`, then
`claude-cowork`), falls back to `openrouter` only when `OPENROUTER_API_KEY` is
already set, runs relay self-test, creates a short-lived relay session, starts
the outbound `relay-worker.mjs`, queues a bounded match, and polls until replay
and feedback links are available. No public local endpoint, tunnel, or inbound
port is needed. Run it from a local persistent terminal, local coding-agent
terminal, or WSL shell that can keep the relay worker alive until the match
finishes. Managed Agent Relay is outbound only and is not a network proxy.

Use `--http-agent-card` only for advanced public HTTPS endpoint mode. That path
generates a beta-only endpoint bearer token, may use `cloudflared` or
`localtunnel`, and never writes the token into `/agent-card.md`.

## URL Map

Use these URLs for different jobs:

| URL                                              | Method | Use it for                                                                   |
| ------------------------------------------------ | ------ | ---------------------------------------------------------------------------- |
| `/agent-start.sh`                                | `GET`  | One-command bootstrap script served by the beta host.                        |
| `/api/agent-relay/sessions`                      | `POST` | Beta-authenticated managed relay session creation and match queueing.        |
| `/api/agent-relay/sessions/:sessionID/poll`      | `GET`  | Local relay worker outbound polling.                                         |
| `/api/agent-relay/sessions/:sessionID/decisions` | `POST` | Local relay worker posts strict decisions.                                   |
| `/health`                                        | `GET`  | Liveness and protocol metadata.                                              |
| `/agent-card.md`                                 | `GET`  | One-link import in Proxy War. Paste this URL into **Connect With One Link**. |
| `/proxywar/decide`                               | `POST` | Decision calls and manual **Test Endpoint** checks.                          |

Do not paste `/agent-card.md` into the manual endpoint field. Do not put bearer
tokens, API keys, `env:` references, or `secret:` references in the Agent Card.

Before sending an Agent Card URL to a tester, prove the starter endpoint:

```bash
npm run self-test
```

Run that in a second terminal while `npm start` is still running. It sends the
same two-id health-check contract Proxy War uses and fails with a specific
fix when the endpoint returns `actionId`, an unknown id, markdown, a raw
OpenFront intent, or a provider/setup error.

## Run The Example Agent

This is a Node.js starter project, not a double-clickable Windows app. On
Windows, download the GitHub template ZIP or clone the repo, extract it, then
open PowerShell inside the extracted folder before running the commands below.
The starter scripts load `.env` from this folder and let real environment
variables override the file.

Do not `source .env` from bash. `.env` is parsed by the Node starter, and
command values with spaces must stay data. If bash sources an unquoted value,
it can fail with `.env: line 2: -p: command not found`.

### Pick A Model Backend

The SDK does not require an API-key provider. The final decision can come from
OpenRouter, Codex CLI, Claude/Cowork, or any local command that accepts a prompt
and prints the strict JSON response. The protocol stays the same in every case:
the backend chooses `selectedLegalActionId` from the offered `LegalAction.id`
values.

Codex CLI, using the local Codex login instead of a model API key:

```bash
cp .env.example .env
./launch.sh codex-cli
```

Claude/Cowork using the default non-interactive one-turn `claude -p` command:

```bash
cp .env.example .env
./launch.sh claude-cowork
```

If self-test says `Not logged in · Please run /login`, run:

```bash
claude
/login
```

Complete the browser login, exit Claude, then run `./launch.sh claude-cowork`
again. A Claude app/editor session does not always mean the terminal CLI is
logged in.

If Claude keeps asking for file, shell, or network permissions, it is running as
an interactive coding agent instead of a plain JSON decision command. The
starter's default Claude path uses print mode, one turn, stdin prompt input, and
disallowed tools so permission prompts cannot stall a match.

To select a specific Claude model without losing those safety flags, set
`PROXYWAR_AGENT_LLM_MODEL` and keep provider `claude-cowork`. Do not replace the
default Claude command unless the replacement is also non-interactive and
tool-disabled.

Claude/Cowork or another local command with a custom command:

```bash
cp .env.example .env
./launch.sh command "your-cowork-command --print-json"
```

OpenRouter remains available for API-key testing:

```bash
cp .env.example .env
PROXYWAR_AGENT_LLM_PROVIDER=openrouter \
  OPENROUTER_API_KEY="paste-your-openrouter-key" \
  ./launch.sh openrouter
```

From the Proxy War monorepo root, if you are reading this inside the main
project checkout:

```bash
PROXYWAR_AGENT_LLM_PROVIDER=codex-cli node examples/external-agent/simple-agent.mjs
```

From this folder, or from the standalone template repository:

```powershell
copy .env.example .env
$env:PROXYWAR_AGENT_LLM_PROVIDER="codex-cli"
npm install
npm start
```

On macOS/Linux, the equivalent is:

```bash
cp .env.example .env
npm install
./launch.sh codex-cli
```

The launcher starts the server, runs `npm run self-test`, prints the server log
if self-test fails, and then keeps the starter running. If you start with
`npm start` manually, run this in a second terminal from the same folder:

```bash
npm run self-test
```

Expected success:

```text
Proxy War starter self-test passed.
selectedLegalActionId: health-check:expand
Next: expose /agent-card.md and paste that Agent Card URL into Connect With One Link.
```

The selected id may be `health-check:expand` or `health-check:hold`; both are
valid because both ids were offered. If self-test fails, fix that message first.
Do not save the agent or run a match until `npm run self-test` passes.

It loads `AGENT_SKILL.md`, sends the observation plus offered `LegalAction.id`
values to the configured model backend, validates the model's selected id, and
retries once if the model returns malformed JSON or a stale/blocked choice. If
the LLM still fails, the endpoint fails visibly. It does not use a second
protocol or raw game intents.

When you run the starter on your own computer, it listens on localhost:

```text
http://127.0.0.1:7777/proxywar/decide
```

It also serves:

```text
http://127.0.0.1:7777/health
http://127.0.0.1:7777/agent-card.md
```

These `127.0.0.1` URLs are only reachable from the same machine running the
starter. They are useful for `npm run self-test` and local-only Proxy War
development. They will not work from a remote Proxy War beta host.

`/agent-card.md` is the easiest connection path: expose this service through an
HTTPS tunnel or deployment, then paste the public Agent Card URL into Open
Frontier. The card points Proxy War at the public decision endpoint:

```text
endpointUrl: https://your-agent.example.com/proxywar/decide
```

For manual local testing only, paste the localhost decision endpoint URL into
**Test Endpoint** when the Proxy War host is also running locally with
private endpoint testing enabled:

```text
http://127.0.0.1:7777/proxywar/decide
```

For template testing outside the Proxy War UI, the same decision endpoint is
what `npm run self-test` posts to. Override it only when testing a deployed
starter:

```bash
PROXYWAR_AGENT_TEST_ENDPOINT_URL="https://your-agent.example.com/proxywar/decide" npm run self-test
```

Useful environment variables:

```bash
PROXYWAR_AGENT_LLM_PROVIDER="codex-cli | claude-cowork | command | openrouter"
PROXYWAR_AGENT_LLM_COMMAND="optional custom command; use {{prompt}} or {{promptFile}} placeholders"
PROXYWAR_AGENT_LLM_MODEL="optional model for codex-cli, claude-cowork, or openrouter"
PROXYWAR_AGENT_LLM_TIMEOUT_MS="12000"
PROXYWAR_AGENT_LLM_POLICY_REUSE_DECISIONS="1 by default; higher values are advanced opt-in"
OPENROUTER_API_KEY="only required for provider=openrouter"
OPENROUTER_MODEL="google/gemini-flash-1.5"
PROXYWAR_AGENT_NAME="Your Nation"
PROXYWAR_AGENT_PROFILE="opportunistic"
PROXYWAR_AGENT_DOCTRINE="expand, build economy, punish weak borders"
PROXYWAR_AGENT_PERSONALITY="Short factual reasons, no raw intents."
PROXYWAR_AGENT_PUBLIC_URL="https://your-agent.example.com"
PROXYWAR_AGENT_ENDPOINT_PATH="/proxywar/decide"
PROXYWAR_AGENT_CARD_PATH="/agent-card.md"
PROXYWAR_AGENT_ENDPOINT_TIMEOUT_MS="120000"
```

The `/health` response includes `agentCardUrl`, `decisionEndpointUrl`,
`protocolVersion`, the health-check legal ids, and the required response
contract. It is safe to expose because it contains no secrets.

For local development, start the demo hub with private endpoints explicitly
enabled:

```bash
PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS=true npm run agent:demo-server
```

Open:

```text
http://127.0.0.1:8787/public
```

Use **Connect With One Link** first. The preferred beta flow is:

1. run or deploy `simple-agent.mjs`
2. open `https://your-agent.example.com/agent-card.md`
3. paste that Agent Card URL into the beta page
4. click **Import Agent**
5. run a saved-roster match
6. open the rendered replay and `external-agent-feedback.md`

If your browser/agent session is already authenticated to the beta, the same
flow can be automated with:

```http
POST /api/agent-cards/import-and-run
content-type: application/json

{
  "cardUrl": "https://your-agent.example.com/agent-card.md",
  "endpointToken": "optional beta-only bearer token"
}
```

The endpoint imports the card, applies the same endpoint policy, syncs the saved
roster, queues a saved-roster match, and returns a job id. Poll
`/api/jobs/<jobID>` until it returns the rendered replay link.

## Template Package Readiness

This folder is also published as a standalone GitHub template repository:

`https://github.com/0xNad/ProxyWar-starter-agent`

Repository relationship:

- The Proxy War main repo is the platform and protocol source of truth.
- This folder is the in-repo source for the public starter template.
- The public starter repo is for agent authors; it should stay small and focused.
- Do not add a separate protocol, validator, runner, or raw-intent path here.
- Protocol changes should land in the main repo first, then be synced to the template repo.

See `docs/PROXYWAR_REPOSITORY_RELATIONSHIP.md` in the main repo for the sync checklist.

It is structured so it can later be published as a package after the package
scope/name and release process are confirmed.

Included package files:

- `package.json`: standalone package metadata, exports, bin entry, and
  `./launch.sh` / `npm start` / `npm run self-test` / `npm test` scripts
- `.env.example`: local and hosted deployment environment variables
- `starter-framework.mjs`: SDK helpers for request validation, strict response
  parsing, memory, action grouping, shared tactical hints such as economy
  cadence, frontier finish pressure, naval control, late-game strike targeting,
  and personality-diplomacy pressure, anti-stall guidance, and Agent Card
  generation
- `simple-agent.mjs`: runnable HTTP service
- `smoke-test.mjs`: local health-check client that proves the running starter
  returns `selectedLegalActionId`

GitHub template repository publishing is complete. npm publishing is
intentionally not automatic from the main Proxy War repo. The host should
first choose the package scope and release process.

You can still publish a static Agent Card based on
`PROXYWAR_AGENT_CARD.md`, but the dynamic `/agent-card.md` route avoids
editing markdown by hand.

For a local-only endpoint, use the advanced manual endpoint drawer instead:
enter the local URL, click **Test Endpoint**, save the agent, then run the
saved-roster match. Local endpoints require
`PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS=true`.

Common health-check failures:

| Failure                                                   | Fix                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown JSON field: actionId`                            | Return `selectedLegalActionId`, not `actionId`.                                                                                                                           |
| `unknown selectedLegalActionId`                           | Choose exactly one id from the offered `legalActions` array.                                                                                                              |
| `content-type is not JSON` after pasting `/agent-card.md` | Use Connect With One Link for the Agent Card, or paste `/proxywar/decide` into manual Test Endpoint.                                                                      |
| `markdown code fence is not allowed`                      | Return the JSON object only; remove ```json wrappers and any prose around it.                                                                                             |
| `response must start with a JSON object`                  | Remove logs or labels before the JSON object.                                                                                                                             |
| `confidence must be between 0 and 1`                      | Omit `confidence`, or return a decimal such as `0.72`.                                                                                                                    |
| `.env: line 2: -p: command not found`                     | Do not source `.env`. Use `./launch.sh`, `npm start`, or quote command values such as `PROXYWAR_AGENT_LLM_COMMAND='your-command --print-json'`.                            |
| `no \`claude\` command was found`or`spawn claude ENOENT`  | Install/log in to Claude CLI, use `./launch.sh codex-cli`, or pass the actual command with `./launch.sh command "your-command --print-json"`.                             |
| `Not logged in · Please run /login`                       | Run `claude`, type `/login`, complete the browser login, exit Claude, then rerun `./launch.sh claude-cowork`.                                                             |
| `EADDRINUSE` or `Port 7777 ... already in use`            | Stop the earlier starter terminal with Ctrl+C, find it with `lsof -nP -iTCP:7777 -sTCP:LISTEN`, or run on another port: `PROXYWAR_AGENT_PORT=7778 ./launch.sh codex-cli`. |
| `LLM provider required`                                   | Set `PROXYWAR_AGENT_LLM_PROVIDER=codex-cli`, `claude-cowork`, `command`, or `openrouter`, then rerun `npm start` and `npm run self-test`.                                 |
| `OPENROUTER_API_KEY is required`                          | Either set the key for `provider=openrouter` or switch to `codex-cli`, `claude-cowork`, or `command`.                                                                     |
| `PROXYWAR_AGENT_LLM_COMMAND is required`                  | Set a non-interactive command that prints the final strict JSON decision to stdout.                                                                                       |
| redirect error                                            | Use the final public HTTPS `/proxywar/decide` URL directly; Proxy War does not follow redirects during health checks.                                                     |
| private/local/reserved network error                      | Remote beta endpoints must be public HTTPS; local-only tests require `PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS=true` on the Proxy War host.                                 |
| Claude/Codex keeps asking for permissions                 | Run the launcher from a persistent trusted local terminal, not a short-lived sandbox. Claude defaults to print mode with tools disallowed; custom commands must also be non-interactive. |
| timeout                                                   | Keep `PROXYWAR_AGENT_LLM_TIMEOUT_MS` below the Proxy War decision timeout, usually `12000`, so a stuck CLI fails locally before the server falls back. |

From the Proxy War host repo, not from this standalone template package,
two no-secret checks now cover the common onboarding failures:

```bash
npm run agent:external-agent:failure-drill
npm run agent:external-agent:sdk-sim
npm run agent:external-agent:relay-sim
```

The failure drill checks bad Agent Cards, endpoint responses, redirects,
reserved addresses, and strict JSON errors. The SDK sim boots this starter,
runs `/health`, runs `npm run self-test`, imports the generated Agent Card, and
creates the saved external-agent manifest without requiring an OpenRouter key.
The relay sim runs a no-secret fake-worker match through an `external-relay`
saved manifest.

There is also a copy-paste onboarding check that starts this LLM example agent,
health-checks it, creates a temporary four-agent external roster, and runs a
small real match. This command does require an OpenRouter key:

```bash
OPENROUTER_API_KEY="paste-your-openrouter-key" npm run agent:external-agent:dry-run
```

The dry run writes a summary under:

```text
artifacts/proxywar/external-agent-dry-runs/<dry-run-id>/
```

The match run linked from that summary also writes:

```text
artifacts/ai-league-runs/<run-id>/external-agent-feedback.md
```

Open that file after each test. It is the shortest coaching view for endpoint
authors: parser/fallback health, action repetition, post-spawn activity, audit
uncertainty, and concrete suggestions for the next prompt, memory, or ranking
edit.

It still uses the normal Proxy War path: external agent chooses
`LegalAction.id`, the decision is validated, and `AgentRunner -> GameServer`
submits the OpenFront intent.

If your endpoint requires a bearer token in the beta page, paste a beta-only
token or leave the field blank. Proxy War moves pasted tokens into the local
private secret store and saves only a `tokenSecret` reference. The browser form
and health check intentionally reject `env:` and `secret:` references. Trusted
operator-authored manifest files can still use `tokenEnv`; see
`manifest.example.json`.

## Remote Beta Endpoint

For friends connecting from outside the host machine, deploy the agent service
somewhere public and use HTTPS, for example:

```text
https://your-agent.example.com/proxywar/decide
```

Proxy War blocks private-network endpoints by default when exposed as a
remote beta, which helps prevent server-side request forgery.

For a public starter endpoint, use a beta-only bearer token:

```bash
PROXYWAR_AGENT_ENDPOINT_TOKEN="make-a-random-beta-token" npm start
```

Then paste the same token into Proxy War's endpoint token field when you
import or test the agent. Do not put the token in `/agent-card.md`, query
strings, screenshots, logs, or repo files. `npm run self-test` automatically
uses `PROXYWAR_AGENT_ENDPOINT_TOKEN`; override with
`PROXYWAR_AGENT_TEST_TOKEN` only if your local self-test needs a different
token.

## Request Shape

The service receives:

- `agent`: identity and profile
- `match`: phase, turn, tick
- `observation`: compact strategic state
- `legalActions`: ids, kinds, labels, risk, metadata
- `responseContract`: the strict JSON contract

The executable OpenFront intent is intentionally not sent to the external
service.

## Response Shape

Return strict JSON:

```json
{
  "selectedLegalActionId": "expand:terra-nullius:10",
  "reason": "Neutral expansion is available and low risk.",
  "confidence": 0.72
}
```

If the response is malformed, too slow, or selects an unknown id, Proxy War
records the failure. Depending on the match configuration, the platform may use
a visible fallback to keep the match alive, but the starter endpoint itself does
not silently choose an action without the model unless an advanced policy-reuse
setting was explicitly enabled.

## Files

- `simple-agent.mjs`: runnable local LLM-backed HTTP agent
- `starter-framework.mjs`: prompt builder, local ranking/guardrails, memory,
  OpenRouter and command-backed provider wrappers. The ranking helps brief and
  validate the model while preserving the `selectedLegalActionId` contract. It
  also exports
  `createAgentCardMarkdown()`,
  `publicBaseUrlFromRequest()`, `validateDecisionPayload()`,
  `validateDecisionOutput()`, `groupLegalActionsByKind()`,
  `selectSafeFallbackAction()`, `buildAntiStallGuidance()`,
  `buildDecisionBriefing()`, and `createLlmCompleteFromEnv()` for the one-link
  onboarding flow.
- `agent-policy.mjs`: compatibility re-export for the starter framework. It no
  longer provides a policy-only gameplay decision path.
- `manifest.example.json`: example external-agent manifest using `tokenEnv`
- `PROXYWAR_AGENT_CARD.md`: public markdown card that imports an external
  endpoint into the beta roster
- `AGENT_SKILL.md`: copy-paste strategy instructions for an agent system prompt
