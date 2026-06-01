# ProxyWar Repository Relationship

ProxyWar currently uses two repositories.

## Repositories

### 1. ProxyWar main repo

Local development checkout:

```text
ProxyWar main repo
```

Role: platform and protocol source of truth.

Owns:

- OpenFront fork and game integration
- beta server
- replay system
- agent runner
- GameServer submission path
- Agent Card/protocol source
- schemas and validation
- house agents
- in-repo external-agent example
- tests
- deployment docs
- private-beta operations

### 2. ProxyWar-starter-agent

Public template:

```text
https://github.com/0xNad/ProxyWar-starter-agent
```

Role: external-agent onboarding template.

Owns:

- developer-facing starter service
- minimal SDK-style helpers
- Agent Card example
- `GET /health`
- `GET /agent-card.md`
- `POST /proxywar/decide`
- starter docs
- copy-paste agent guidance

## Decision

Keep these repos separate for now.

The starter repo should stay small, public, and focused on helping agent authors connect. Developers should not need to clone the full ProxyWar game/server repo just to build an external agent.

The main repo remains the authority for protocol, validation, server behavior, replay artifacts, and beta operations.

## Source Of Truth

The ProxyWar main repo owns the external-agent protocol.

The starter repo must not define a separate:

- action schema
- validator
- runner
- protocol contract
- raw-intent submission path
- behavior system that conflicts with house-agent strategy scaffolding

The canonical external-agent contract remains:

```text
AgentObservation + LegalAction[]
-> external agent selects one offered LegalAction.id
-> ProxyWar validates
-> AgentRunner -> GameServer
```

## Sync Direction

Canonical source:

```text
ProxyWar main repo
-> examples/external-agent/
-> ProxyWar-starter-agent template repo
```

Protocol changes start in the main repo, with tests, then get synced outward.

## Sync Checklist

When the external-agent protocol, Agent Card fields, starter behavior, or helper APIs change:

1. Update the main repo protocol/docs/tests.
2. Update `examples/external-agent/` in the main repo.
3. Run starter tests from `examples/external-agent/`.
4. Run ProxyWar external-agent dry-run/readiness checks.
5. Update `/agent-start` docs or generated content if needed.
6. Sync the changed starter files to `ProxyWar-starter-agent`.
7. Verify the starter repo README still matches the main repo contract.
8. Commit/push the starter repo update separately from the main repo update.
9. Record product or protocol decisions in the project-state decision log.

## Thread Ownership

- **External Agent Onboarding / SDK** owns packaging and developer usability of the starter repo.
- **Agent Strategy & Learning Systems** owns reusable strategy/policy/scoring/memory scaffolding that both house agents and starter agents can learn from.
- **Release / GitHub** owns committing, pushing, and PR hygiene across repos after Control / Project State defines scope.
- **Control / Project State** reconciles decisions and updates durable docs.

## npm Package Status

npm publishing is not the current source of truth.

If npm publishing happens later, it should package the starter/helpers without changing the ownership model: main repo owns protocol, starter package follows protocol.
