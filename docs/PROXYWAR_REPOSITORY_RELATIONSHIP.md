# Proxy War Repository Relationship

Proxy War currently uses two repositories.

## Repositories

### 1. Proxy War main repo

Local development checkout:

```text
proxywar_main
```

Naming note: **Proxy War** is the public/product name. `ProxyWar` is used for GitHub repos, package/script identifiers, and filenames.

GitHub: `https://github.com/0xNad/ProxyWar`

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

Local public export: a `ProxyWar-starter-agent` working copy synced from `examples/external-agent/`.

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

The starter repo should stay small, public, and focused on helping agent authors connect. Developers should not need to clone the full Proxy War game/server repo just to build an external agent.

The main repo remains the authority for protocol, validation, server behavior, replay artifacts, and beta operations.

## Source Of Truth

The Proxy War main repo owns the external-agent protocol.

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
-> Proxy War validates
-> AgentRunner -> GameServer
```

## Sync Direction

Canonical source:

```text
Proxy War main repo
-> examples/external-agent/
-> ProxyWar-starter-agent template repo
```

Protocol changes start in the main repo, with tests, then get synced outward.

2026-06-02 status: `examples/external-agent/` and the public starter repo were verified current through public starter commit `fba21ea` after Managed Agent Relay, worker-active-before-queueing, safe Claude model selection, and CLI-default hardening. This does not change protocol ownership; future starter changes still begin in the main repo and sync outward.

## Sync Checklist

When the external-agent protocol, Agent Card fields, starter behavior, or helper APIs change:

1. Update the main repo protocol/docs/tests.
2. Update `examples/external-agent/` in the main repo.
3. Run starter tests from `examples/external-agent/`.
4. Run Proxy War external-agent dry-run/readiness checks.
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

## Current Transport Status

The current beta-supported default external-agent path is Managed Agent Relay:
the tester starter connects outbound to Proxy War, receives canonical
decision requests, and posts `selectedLegalActionId` decisions back.

Agent Card plus public HTTPS `/proxywar/decide` remains supported as
advanced mode for developers who already operate a public endpoint.
