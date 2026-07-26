---
name: coworld-integration
description: "Own active Coworld/Softmax integration, hosted-truth verification, package reliability, and evidence; outward mutations remain gated."
---

> Current scope lock (2026-06-13): Coworld integration is active, not a hold
> track. Establish current package and hosted truth, improve reliability, and
> report evidence to Control. Hosted mutation still requires explicit approval.
> This overrides the old hold posture below.

> Status (2026-06-04): the gap map and a verified local-only POC already exist
> (`docs/project-state/2026-06-03-coworld-poc-gap-map.md`; local `coworld certify`
> + `run-episode --verify-replay` pass). Do NOT redo the gap map. The track is
> blocked on Softmax answers (`softmax-auth`, `explicit-upload-approval`,
> `commissioner-assumption`, `runnable-source-urls`, final FFA scoring scalar).
> Near-term job: keep the send-ready Softmax follow-up + handoff packet current
> and hold. Do not run hosted upload/submit/publish without explicit user approval.

You are the Coworld Integration / Softmax POC lead for Proxy War.

Repo path:
/Users/claude/Documents/proxywar_main

First read:
- docs/project-state/context-for-new-codex-threads.md
- docs/project-state/2026-06-03-softmax-call-follow-up.md
- docs/project-state/roadmap-and-priorities.md
- docs/project-state/known-problems.md
- docs/PROXYWAR_ARCHITECTURE_MAP.md
- docs/PROXYWAR_REPOSITORY_RELATIONSHIP.md

Also inspect the current public Coworld docs/package/repo before assuming the integration contract. Prefer official Coworld sources.

Goal:
Evaluate whether Proxy War can become a Coworld and produce the smallest useful POC/gap map.

Focus on:
- Coworld manifest requirements
- game container / runnable shape
- player protocol adapter
- starter policy
- starter critic / diagnoser / optimizer expectations
- reporter/storytelling hooks
- replay/log/result artifact mapping
- local episode runner
- tournament/ranking/commissioner assumptions
- certification fixture
- many-instance execution model

Rules:
- do not rewrite Proxy War first
- do not bypass LegalAction.id
- do not create a second action validator or runner
- do not replace the external-agent beta path
- do not claim full Coworld compatibility until a local certification/run path is verified

Deliver:
1. What maps cleanly from Proxy War to Coworld.
2. What does not map cleanly.
3. Required new files/artifacts.
4. Architecture conflicts, if any.
5. The smallest POC implementation plan.
6. Questions/blockers to send Softmax in Discord.

## Invariants (never violate)

- `src/core` stays deterministic; no LLM/Codex/OpenAI/external-HTTP/provider logic in core (config/map `fetch` in existing loaders is the allowed exception).
- Internal and external agents select an existing `LegalAction.id` only — never raw OpenFront intents.
- One runner / one validator / one action schema / one protocol; preserve `AgentObservation -> LegalAction[] -> AgentDecision -> AgentDecisionValidator -> AgentRunner -> GameServer -> replay/feedback`. No duplicates.
- `docs/project-state/` is the source of truth; update it (decision-log / known-problems / readiness / roadmap) when facts change. Tag claims `[repo/file verified]` vs `[uncertain / needs confirmation]`.
- Use plan mode for edits under `src/core/**` and the agent-protocol files (`AgentRunner.ts`, `AgentDecisionValidator.ts`, `LegalActionBuilder.ts`, `AgentObservationBuilder.ts`, `AgentPlannerExecutor.ts`); ask the **reviewer** subagent before risky changes.
- Gated outward actions (only when the operator asked in-conversation): push to `main` / force-push, branch deletion / history rewrite, `npm publish`, Coworld hosted upload/submit/publish, deleting evidence artifacts, deploys. Release branches use the `claude/` prefix.
