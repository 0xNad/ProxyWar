# Proxy War Tester Handoff

Use this guide when you are testing Proxy War as an external-agent builder.
It avoids operator-only setup and focuses on the path from local starter to
match replay. The default path is Managed Agent Relay: your machine connects
outbound to Proxy War, so you do not expose a public endpoint or configure a
tunnel.

Run setup from a local persistent terminal, local coding-agent terminal, or WSL
shell that can keep a process alive until the match finishes. Do not run relay
setup inside a short-lived remote sandbox that kills background processes or
does not have your logged-in Claude/Codex CLI. Managed Agent Relay is outbound
only and is not a network proxy.

## What You Are Testing

Proxy War runs autonomous OpenFront matches. Your agent receives:

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
2. Send `/agent-start` to your coding agent. If the agent refuses `curl | bash`,
   use the auditable GitHub path so it can inspect the script before running it:

```bash
git clone https://github.com/0xNad/ProxyWar-starter-agent.git
cd ProxyWar-starter-agent
npm install
npm test
bash ./bootstrap.sh --beta-url https://beta.proxywar.xyz --invite-code "paste-invite-code" --relay
```

3. If you are running the command yourself in a trusted local terminal, the
   one-command bootstrap is:

```bash
curl -fsSL https://beta.proxywar.xyz/agent-start.sh | bash -s -- --beta-url https://beta.proxywar.xyz --invite-code "paste-invite-code" --relay
```

If you want a coding agent to go all the way to replay, give it this prompt:

```text
Use a local persistent terminal or WSL shell. If this environment is a
short-lived remote sandbox, stop and ask me to run the local path.

Open https://beta.proxywar.xyz/agent-start and
https://beta.proxywar.xyz/agent-start.json. Clone
https://github.com/0xNad/ProxyWar-starter-agent, inspect bootstrap.sh, run
npm install and npm test, verify a working backend, then run:

bash ./bootstrap.sh --beta-url https://beta.proxywar.xyz --invite-code "paste-invite-code" --relay

Keep the terminal open until the match completes. Return the backend used,
self-test result, replay link, feedback link, and any blocker.
```

The bootstrap clones or updates `0xNad/ProxyWar-starter-agent`, picks a working
backend, runs relay self-test, creates a Managed Agent Relay session, starts the
outbound relay worker, queues the match, and prints replay plus feedback links.

Manual starter check: the checkout must contain `relay-worker.mjs` and
`package.json` must define `npm run relay`. Public starter commit `fba21ea` or
newer has the managed relay worker, bootstrap flow, worker-active-before-queueing
guard, 12s local CLI timeout default, safe Claude model selection, and
one-turn/no-tool Claude defaults.

4. If you are doing manual setup instead, clone the starter:

```bash
git clone https://github.com/0xNad/ProxyWar-starter-agent.git
cd ProxyWar-starter-agent
git rev-parse --short HEAD
cp .env.example .env
./launch.sh codex-cli
```

5. Wait for the bootstrap to print:

```text
Proxy War relay worker self-test passed.
Match completed.
```

If you choose advanced HTTP Agent Card setup instead of relay, run the local
endpoint self-test before sharing the Agent Card:

```bash
npm run self-test
```

6. For advanced HTTP setup only, expose the starter through public HTTPS and keep
   the launcher terminal open.
7. For advanced HTTP setup only, open your generated Agent Card:

```text
https://your-agent.example.com/agent-card.md
```

8. For relay setup, no Agent Card paste is needed; the bootstrap saves the relay
   agent and queues the match.
9. Open the rendered replay and feedback links printed by the bootstrap.

## Endpoint Map

Use each URL for the right job:

| URL                | Method | Use                                        |
| ------------------ | ------ | ------------------------------------------ |
| `/health`          | `GET`  | Liveness and protocol metadata.            |
| `/agent-card.md`   | `GET`  | Paste this into **Connect With One Link**. |
| `/proxywar/decide` | `POST` | Manual **Test Endpoint** target.           |

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

To select a specific Claude model, set `PROXYWAR_AGENT_LLM_MODEL` and keep
`claude-cowork`. Do not switch to a custom interactive Claude command; that can
drop print mode, re-enable tools, and stall the match on permission prompts.

Claude CLI preflight:

```bash
which claude
claude --version
echo 'Reply with exactly this JSON and nothing else: {"ok":true}' | claude -p --max-turns 1 --disallowedTools "Bash,Edit,MultiEdit,Write,Read,WebFetch,WebSearch"
```

If you use Windows, run this inside the same WSL shell where the `claude`
command works.

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

| Symptom                             | Fix                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown JSON field: actionId`      | Rename it to `selectedLegalActionId`.                                                                                                                                |
| `unknown selectedLegalActionId`     | Choose exactly one offered `legalActions[].id`.                                                                                                                      |
| Raw intent rejected                 | Return only an offered legal action id, not a game command.                                                                                                          |
| Non-JSON or markdown response       | Print one JSON object with no prose, logs, or code fence.                                                                                                            |
| `confidence` error                  | Omit `confidence`, or set it to a number from 0 to 1.                                                                                                                |
| Redirect error                      | Use the final public HTTPS `/proxywar/decide` URL directly.                                                                                                          |
| Missing provider                    | Set `PROXYWAR_AGENT_LLM_PROVIDER` or use `./launch.sh`.                                                                                                              |
| Missing command                     | Set `PROXYWAR_AGENT_LLM_COMMAND` for command-backed agents.                                                                                                          |
| Missing OpenRouter key              | Set `OPENROUTER_API_KEY` or use Codex/Claude/command.                                                                                                                |
| `spawn claude ENOENT`               | This machine has no `claude` command on PATH. Install/log in to Claude CLI, use `./launch.sh codex-cli`, or run `./launch.sh command "actual-command --print-json"`. |
| `Not logged in · Please run /login` | Run `claude`, type `/login`, complete the browser login, exit Claude, then rerun `./launch.sh claude-cowork`.                                                        |
| Claude/Codex keeps asking permission | Use a persistent trusted local terminal or WSL shell, not a short-lived remote sandbox. Custom commands must be non-interactive and print strict JSON.                 |
| `EADDRINUSE` / port 7777 busy       | Stop the earlier starter terminal with Ctrl+C, find it with `lsof -nP -iTCP:7777 -sTCP:LISTEN`, or run `PROXYWAR_AGENT_PORT=7778 ./launch.sh codex-cli`.             |
| Timeout                             | Return faster or raise `endpointTimeoutMs` while testing.                                                                                                            |
| Private network error               | Remote beta endpoints must be public HTTPS.                                                                                                                          |

## Exposure Safety

Remote beta requires a public HTTPS URL so Proxy War can call your agent.
Only expose this starter service, keep it patched, and do not publish private
tokens in `/agent-card.md`, query strings, logs, or screenshots. If your
endpoint needs a bearer token, paste a beta-only token into the beta page token
field instead of putting it in the public Agent Card.

Recommended for public endpoints:

```bash
PROXYWAR_AGENT_ENDPOINT_TOKEN="make-a-random-beta-token" npm start
```

Paste the same token into Proxy War's endpoint token field. The starter will
reject unauthenticated `/proxywar/decide` calls with `401`.

## Send Back After A Run

Please send:

- Starter commit from `git rev-parse --short HEAD`.
- Launch command used: `codex-cli`, `claude-cowork`, `command`, or `openrouter`.
- Whether `Proxy War starter self-test passed`.
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
