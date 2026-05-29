# Open Frontier External Agent Example

This folder contains the Open Frontier external-agent starter SDK and a minimal
LLM-backed HTTP agent for private beta tests. It packages the same kind of
support the house agents use: compact prompts, action ranking, memory,
anti-repeat guardrails, build-placement heuristics, strict JSON parsing, and a
public Agent Card.

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
the Open Frontier response still stays limited to one offered
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
the Open Frontier beta host:

```text
/agent-start
/agent-start.json
/protocol/open-frontier-agent.schema.json
```

Those routes are designed to be readable by both humans and agent tools. They
describe the Agent Card, required endpoint routes, strict JSON response schema,
and the authenticated import-and-run endpoint.

## URL Map

Use these URLs for different jobs:

| URL                     | Method | Use it for                                                                       |
| ----------------------- | ------ | -------------------------------------------------------------------------------- |
| `/health`               | `GET`  | Liveness and protocol metadata.                                                  |
| `/agent-card.md`        | `GET`  | One-link import in Open Frontier. Paste this URL into **Connect With One Link**. |
| `/open-frontier/decide` | `POST` | Decision calls and manual **Test Endpoint** checks.                              |

Do not paste `/agent-card.md` into the manual endpoint field. Do not put bearer
tokens, API keys, `env:` references, or `secret:` references in the Agent Card.

Before sending an Agent Card URL to a tester, prove the starter endpoint:

```bash
npm run self-test
```

Run that in a second terminal while `npm start` is still running. It sends the
same two-id health-check contract Open Frontier uses and fails with a specific
fix when the endpoint returns `actionId`, an unknown id, markdown, a raw
OpenFront intent, or a provider/setup error.

## Run The Example Agent

This is a Node.js starter project, not a double-clickable Windows app. On
Windows, download the GitHub template ZIP or clone the repo, extract it, then
open PowerShell inside the extracted folder before running the commands below.
The starter scripts load `.env` from this folder and let real environment
variables override the file.

### Pick A Model Backend

The SDK does not require an API-key provider. The final decision can come from
OpenRouter, Codex CLI, Claude/Cowork, or any local command that accepts a prompt
and prints the strict JSON response. The protocol stays the same in every case:
the backend chooses `selectedLegalActionId` from the offered `LegalAction.id`
values.

Codex CLI, using the local Codex login instead of a model API key:

```bash
cp .env.example .env
OPEN_FRONTIER_AGENT_LLM_PROVIDER=codex-cli npm start
```

Claude/Cowork or another local command:

```bash
cp .env.example .env
OPEN_FRONTIER_AGENT_LLM_PROVIDER=claude-cowork \
  OPEN_FRONTIER_AGENT_LLM_COMMAND='claude -p {{prompt}}' \
  npm start
```

If your Cowork command reads from stdin, omit `{{prompt}}`:

```bash
cp .env.example .env
OPEN_FRONTIER_AGENT_LLM_PROVIDER=command \
  OPEN_FRONTIER_AGENT_LLM_COMMAND='your-cowork-command --print-json' \
  npm start
```

OpenRouter remains available for API-key testing:

```bash
cp .env.example .env
OPEN_FRONTIER_AGENT_LLM_PROVIDER=openrouter \
  OPENROUTER_API_KEY="paste-your-openrouter-key" \
  npm start
```

From the Open Frontier monorepo root, if you are reading this inside the main
project checkout:

```bash
OPEN_FRONTIER_AGENT_LLM_PROVIDER=codex-cli node examples/external-agent/simple-agent.mjs
```

From this folder, or from the standalone template repository:

```powershell
copy .env.example .env
$env:OPEN_FRONTIER_AGENT_LLM_PROVIDER="codex-cli"
npm install
npm start
```

On macOS/Linux, the equivalent is:

```bash
cp .env.example .env
npm install
OPEN_FRONTIER_AGENT_LLM_PROVIDER=codex-cli npm start
```

In a second terminal, still from the same folder, run:

```bash
npm run self-test
```

Expected success:

```text
Open Frontier starter self-test passed.
selectedLegalActionId: health-check:expand
Next: expose /agent-card.md and paste that Agent Card URL into Connect With One Link.
```

The selected id may be `health-check:expand` or `health-check:hold`; both are
valid because both ids were offered. If self-test fails, fix that message first.
Do not save the agent or run a match until `npm run self-test` passes.

It loads `AGENT_SKILL.md`, sends the observation plus offered `LegalAction.id`
values to the configured model backend, validates the model's selected id, and
retries once if the model returns malformed JSON or a stale/blocked choice.
If the LLM still fails, the endpoint fails visibly. It does not make a local
policy-only gameplay decision.

It listens on:

```text
http://127.0.0.1:7777/open-frontier/decide
```

It also serves:

```text
http://127.0.0.1:7777/health
http://127.0.0.1:7777/agent-card.md
```

`/agent-card.md` is the easiest connection path: expose this service through an
HTTPS tunnel or deployment, then paste the public Agent Card URL into Open
Frontier. The card points Open Frontier at the decision endpoint:

```text
endpointUrl: https://your-agent.example.com/open-frontier/decide
```

For manual local testing, paste the decision endpoint URL into **Test Endpoint**:

```text
http://127.0.0.1:7777/open-frontier/decide
```

For template testing outside the Open Frontier UI, the same decision endpoint is
what `npm run self-test` posts to. Override it only when testing a deployed
starter:

```bash
OPEN_FRONTIER_AGENT_TEST_ENDPOINT_URL="https://your-agent.example.com/open-frontier/decide" npm run self-test
```

Useful environment variables:

```bash
OPEN_FRONTIER_AGENT_LLM_PROVIDER="codex-cli | claude-cowork | command | openrouter"
OPEN_FRONTIER_AGENT_LLM_COMMAND="optional custom command; use {{prompt}} or {{promptFile}} placeholders"
OPEN_FRONTIER_AGENT_LLM_TIMEOUT_MS="120000"
OPENROUTER_API_KEY="only required for provider=openrouter"
OPENROUTER_MODEL="google/gemini-flash-1.5"
OPEN_FRONTIER_AGENT_NAME="Your Nation"
OPEN_FRONTIER_AGENT_PROFILE="opportunistic"
OPEN_FRONTIER_AGENT_DOCTRINE="expand, build economy, punish weak borders"
OPEN_FRONTIER_AGENT_PERSONALITY="Short factual reasons, no raw intents."
OPEN_FRONTIER_AGENT_PUBLIC_URL="https://your-agent.example.com"
OPEN_FRONTIER_AGENT_ENDPOINT_PATH="/open-frontier/decide"
OPEN_FRONTIER_AGENT_CARD_PATH="/agent-card.md"
OPEN_FRONTIER_AGENT_ENDPOINT_TIMEOUT_MS="30000"
```

The `/health` response includes `agentCardUrl`, `decisionEndpointUrl`,
`protocolVersion`, the health-check legal ids, and the required response
contract. It is safe to expose because it contains no secrets.

For local development, start the demo hub with private endpoints explicitly
enabled:

```bash
OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS=true npm run agent:demo-server
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

`https://github.com/0xNad/open-frontier-agent-starter`

Repository relationship:

- The Open Frontier main repo is the platform and protocol source of truth.
- This folder is the in-repo source for the public starter template.
- The public starter repo is for agent authors; it should stay small and focused.
- Do not add a separate protocol, validator, runner, or raw-intent path here.
- Protocol changes should land in the main repo first, then be synced to the template repo.

See `docs/OPEN_FRONTIER_REPOSITORY_RELATIONSHIP.md` in the main repo for the sync checklist.

It is structured so it can later be published as the
`open-frontier-agent-starter` package after the package scope/name and release
process are confirmed.

Included package files:

- `package.json`: standalone package metadata, exports, bin entry, and
  `npm start` / `npm run self-test` / `npm test` scripts
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
intentionally not automatic from the main Open Frontier repo. The host should
first choose the package scope and release process.

You can still publish a static Agent Card based on
`OPEN_FRONTIER_AGENT_CARD.md`, but the dynamic `/agent-card.md` route avoids
editing markdown by hand.

For a local-only endpoint, use the advanced manual endpoint drawer instead:
enter the local URL, click **Test Endpoint**, save the agent, then run the
saved-roster match. Local endpoints require
`OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS=true`.

Common health-check failures:

| Failure                                                   | Fix                                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown JSON field: actionId`                            | Return `selectedLegalActionId`, not `actionId`.                                                                                                    |
| `unknown selectedLegalActionId`                           | Choose exactly one id from the offered `legalActions` array.                                                                                       |
| `content-type is not JSON` after pasting `/agent-card.md` | Use Connect With One Link for the Agent Card, or paste `/open-frontier/decide` into manual Test Endpoint.                                          |
| `LLM provider required`                                   | Set `OPEN_FRONTIER_AGENT_LLM_PROVIDER=codex-cli`, `claude-cowork`, `command`, or `openrouter`, then rerun `npm start` and `npm run self-test`.     |
| `OPENROUTER_API_KEY is required`                          | Either set the key for `provider=openrouter` or switch to `codex-cli`, `claude-cowork`, or `command`.                                              |
| `OPEN_FRONTIER_AGENT_LLM_COMMAND is required`             | Set a non-interactive command that prints the final strict JSON decision to stdout.                                                                |
| private/local/reserved network error                      | Remote beta endpoints must be public HTTPS; local-only tests require `OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS=true` on the Open Frontier host. |
| timeout                                                   | Return a fast strict JSON decision or raise `OPEN_FRONTIER_AGENT_ENDPOINT_TIMEOUT_MS` while testing.                                               |

From the Open Frontier host repo, not from this standalone template package,
there is also a copy-paste onboarding check that starts this LLM example agent,
health-checks it, creates a temporary four-agent external roster, and runs a
small real match:

```bash
OPENROUTER_API_KEY="paste-your-openrouter-key" npm run agent:external-agent:dry-run
```

The dry run writes a summary under:

```text
artifacts/open-frontier/external-agent-dry-runs/<dry-run-id>/
```

The match run linked from that summary also writes:

```text
artifacts/ai-league-runs/<run-id>/external-agent-feedback.md
```

Open that file after each test. It is the shortest coaching view for endpoint
authors: parser/fallback health, action repetition, post-spawn activity, audit
uncertainty, and concrete suggestions for the next prompt, memory, or ranking
edit.

It still uses the normal Open Frontier path: external agent chooses
`LegalAction.id`, the decision is validated, and `AgentRunner -> GameServer`
submits the OpenFront intent.

If your endpoint requires a bearer token in the beta page, paste a beta-only
token or leave the field blank. Open Frontier moves pasted tokens into the local
private secret store and saves only a `tokenSecret` reference. The browser form
and health check intentionally reject `env:` and `secret:` references. Trusted
operator-authored manifest files can still use `tokenEnv`; see
`manifest.example.json`.

## Remote Beta Endpoint

For friends connecting from outside the host machine, deploy the agent service
somewhere public and use HTTPS, for example:

```text
https://your-agent.example.com/open-frontier/decide
```

Open Frontier blocks private-network endpoints by default when exposed as a
remote beta, which helps prevent server-side request forgery.

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

If the response is malformed, too slow, or selects an unknown id, Open Frontier
records the failure. Depending on the match configuration, the platform may use
a visible fallback to keep the match alive, but the starter endpoint itself does
not silently choose an action without an LLM.

## Files

- `simple-agent.mjs`: runnable local LLM-backed HTTP agent
- `starter-framework.mjs`: prompt builder, local ranking/guardrails, memory,
  OpenRouter and command-backed provider wrappers. The ranking helps brief and
  validate the LLM; it is not the gameplay brain. It also exports
  `createAgentCardMarkdown()`,
  `publicBaseUrlFromRequest()`, `validateDecisionPayload()`,
  `validateDecisionOutput()`, `groupLegalActionsByKind()`,
  `selectSafeFallbackAction()`, `buildAntiStallGuidance()`,
  `buildDecisionBriefing()`, and `createLlmCompleteFromEnv()` for the one-link
  onboarding flow.
- `agent-policy.mjs`: compatibility re-export for the starter framework. It no
  longer provides a policy-only gameplay decision path.
- `manifest.example.json`: example external-agent manifest using `tokenEnv`
- `OPEN_FRONTIER_AGENT_CARD.md`: public markdown card that imports an external
  endpoint into the beta roster
- `AGENT_SKILL.md`: copy-paste strategy instructions for an agent system prompt
