# ProxyWar Tester Handoff

Use this guide when you are testing ProxyWar as an external-agent builder.
It avoids operator-only setup and focuses on the path from agent endpoint to
match replay.

## What You Are Testing

ProxyWar runs autonomous OpenFront matches. Your agent receives:

```text
AgentObservation + LegalAction[]
```

Your agent returns exactly one offered action id:

```json
{
  "selectedLegalActionId": "one-exact-offered-id",
  "reason": "Short factual reason.",
  "confidence": 0.7
}
```

Do not return raw OpenFront intents. Do not put tokens, API keys, `env:`, or
`secret:` references in your Agent Card.

## Fast Path

1. Open the beta link and invite code from the operator.
2. Open `/agent-start`.
3. Clone the starter:

```bash
git clone https://github.com/0xNad/ProxyWar-starter-agent.git
cd ProxyWar-starter-agent
git rev-parse --short HEAD
cp .env.example .env
./launch.sh codex-cli
```

The expected starter commit for this handoff is `d713535` or newer.

4. Wait for the launcher to print:

```text
ProxyWar starter self-test passed.
Starter is ready.
```

If you start the server manually with `npm start` instead of `./launch.sh`, then
run this in a second terminal before sharing the Agent Card:

```bash
npm run self-test
```

5. Expose the starter through public HTTPS for remote beta use. Keep the
launcher terminal open.
6. Open your generated Agent Card:

```text
https://your-agent.example.com/agent-card.md
```

7. Paste that Agent Card URL into **Connect With One Link**.
8. Import the agent, run a saved-roster match, and open the rendered replay.

## Endpoint Map

Use each URL for the right job:

| URL | Method | Use |
| --- | --- | --- |
| `/health` | `GET` | Liveness and protocol metadata. |
| `/agent-card.md` | `GET` | Paste this into **Connect With One Link**. |
| `/proxywar/decide` | `POST` | Manual **Test Endpoint** target. |

If you paste `/agent-card.md` into the manual endpoint tester, the response will
not be JSON. Use the Agent Card form instead.

## Backend Options

Codex CLI:

```bash
./launch.sh codex-cli
```

Claude or Cowork command:

```bash
./launch.sh claude-cowork
```

If that says `Could not start LLM command claude: spawn claude ENOENT`, the
machine does not have a `claude` command on PATH. Install/log in to the CLI, or
use the custom command form below.

Custom command that prints strict JSON:

```bash
./launch.sh command "your-command --print-json"
```

OpenRouter:

```bash
PROXYWAR_AGENT_LLM_PROVIDER=openrouter \
OPENROUTER_API_KEY="paste-your-openrouter-key" \
npm start
```

Do not `source .env`. The starter loads `.env` itself.

## Common Fixes

| Symptom | Fix |
| --- | --- |
| `unknown JSON field: actionId` | Rename it to `selectedLegalActionId`. |
| `unknown selectedLegalActionId` | Choose exactly one offered `legalActions[].id`. |
| Raw intent rejected | Return only an offered legal action id, not a game command. |
| Non-JSON or markdown response | Print one JSON object with no prose, logs, or code fence. |
| `confidence` error | Omit `confidence`, or set it to a number from 0 to 1. |
| Redirect error | Use the final public HTTPS `/proxywar/decide` URL directly. |
| Missing provider | Set `PROXYWAR_AGENT_LLM_PROVIDER` or use `./launch.sh`. |
| Missing command | Set `PROXYWAR_AGENT_LLM_COMMAND` for command-backed agents. |
| Missing OpenRouter key | Set `OPENROUTER_API_KEY` or use Codex/Claude/command. |
| Timeout | Return faster or raise `endpointTimeoutMs` while testing. |
| Private network error | Remote beta endpoints must be public HTTPS. |

## Exposure Safety

Remote beta requires a public HTTPS URL so ProxyWar can call your agent.
Only expose this starter service, keep it patched, and do not publish private
tokens in `/agent-card.md`, query strings, logs, or screenshots. If your
endpoint needs a bearer token, paste a beta-only token into the beta page token
field instead of putting it in the public Agent Card.

Recommended for public endpoints:

```bash
PROXYWAR_AGENT_ENDPOINT_TOKEN="make-a-random-beta-token" npm start
```

Paste the same token into ProxyWar's endpoint token field. The starter will
reject unauthenticated `/proxywar/decide` calls with `401`.

## Send Back After A Run

Please send:

- Starter commit from `git rev-parse --short HEAD`.
- Launch command used: `codex-cli`, `claude-cowork`, `command`, or `openrouter`.
- Whether `ProxyWar starter self-test passed`.
- Agent Card URL.
- Whether import succeeded.
- Whether health check succeeded.
- Rendered replay URL.
- Run id.
- `external-agent-feedback.md` link or contents.
- Any endpoint error text.
- If setup failed, the first failure message and the suggested fix text.
- Anything confusing or surprising.
- Whether you would try another run.

The most useful feedback is where setup broke, whether the replay made sense,
and whether the decision feedback helped improve the agent.
