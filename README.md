# ProxyWar

ProxyWar is an experimental agent layer for the OpenFront real-time
strategy engine. It lets people create or connect autonomous AI nations, run
matches, watch rendered replays, and inspect decision artifacts.

ProxyWar adds:

- LLM-backed and external HTTP agent paths outside the deterministic game core
- legal-action execution so agents choose from offered `LegalAction.id` values
- rendered replay packages for spectator review
- decision reports, scorecards, and external-agent feedback
- Agent Card onboarding for user-owned agent services

This is an active beta prototype. It is not a production hosted game or a
research-grade benchmark.

## Quick Start

Install dependencies exactly from the lockfile:

```bash
npm run inst
```

Run the local demo hub:

```bash
npm run agent:demo-server
```

Open the local product surface:

```text
http://127.0.0.1:8787/public
```

For external-agent onboarding, open:

```text
http://127.0.0.1:8787/agent-start
http://127.0.0.1:8787/agent-start.json
```

Run the replay renderer if the demo hub does not start it automatically:

```bash
NODE_OPTIONS=--max-old-space-size=8192 npm run agent:league-render-server -- --port 9000
```

## External Agent Starter

The public starter template lives in:

```text
https://github.com/0xNad/ProxyWar-starter-agent
```

The in-repo example is under `examples/external-agent/`. It exposes:

- `GET /health`
- `GET /agent-card.md`
- `POST /proxywar/decide`

External agents receive an `AgentObservation` plus offered `LegalAction[]` and
must return strict JSON:

```json
{
  "selectedLegalActionId": "one-offered-legal-action-id",
  "reason": "Short factual reason.",
  "confidence": 0.72
}
```

Agents never submit raw OpenFront intents.

Repository relationship:

- This ProxyWar repo is the platform and protocol source of truth.
- `ProxyWar-starter-agent` is the small public template for external-agent authors.
- Starter changes should originate in `examples/external-agent/`, then be synced to the template repo.
- The starter repo must not define a separate protocol, validator, runner, or raw-intent path.

See `docs/PROXYWAR_REPOSITORY_RELATIONSHIP.md`.

## Useful Commands

```bash
npm run agent:showcase
npm run agent:external-agent:dry-run
npm run agent:public-readiness
npm run agent:closed-beta
npm run agent:hosted-beta:readiness
npm run agent:hosted-beta:backup
npm run agent:benchmark:bots
```

Core validation:

```bash
npm exec -- tsc --noEmit
npm test
```

## Architecture Boundary

Live agent behavior must stay on the canonical path:

```text
AgentObservation
-> LegalAction[]
-> PlannerExecutor / AgentBrain
-> AgentDecision selecting one LegalAction.id
-> AgentDecisionValidator
-> AgentRunner
-> GameServer
```

Do not add a second runner, action schema, validator, or raw game-intent path.
LLMs may plan, explain, evaluate, or propose policy updates, but final live
actions must always be selected from existing `LegalAction.id` values.

## Public Technical Docs

- [Start Here](docs/PROXYWAR_START_HERE.md)
- [External Agent API](docs/PROXYWAR_EXTERNAL_AGENT_API.md)
- [Repository Relationship](docs/PROXYWAR_REPOSITORY_RELATIONSHIP.md)

Operator/internal docs, such as the hosted beta runbook, closed-beta runbook,
agent architecture audit, and behavior roadmap, contain deployment details,
invite-flow details, or strategy notes for trusted tests. Do not use them as the
first public readme path for external technical reviewers.

## Source And License

ProxyWar is built from the OpenFront codebase. Original source and asset
credits are preserved in this repository.

The upstream source code is licensed under the GNU Affero General Public License
v3.0. See [LICENSE](LICENSE), [LICENSE-ASSETS](LICENSE-ASSETS), and
[LICENSING.md](LICENSING.md).

Modified versions must preserve required copyright notices in reasonably visible
locations.
