# ProxyWar hard rules

Always-apply. These are the rules that must survive a long session, not the full
brief — background lives in `.omp/AGENTS.md` and `docs/project-state/`.

## Simulation invariants

- `src/core` stays deterministic: seeded PRNG, no floating-point simulation math.
- No LLM / Codex / OpenAI / provider / external-agent HTTP logic in `src/core`.
  Config and map loading over `fetch` in the existing loaders is the one allowed
  exception.
- Agents choose an existing `LegalAction.id`. Never let an agent or an LLM emit a
  raw OpenFront intent.
- Preserve the canonical path, and do not build a second one:
  `AgentObservation -> LegalAction[] -> AgentDecision -> AgentDecisionValidator -> AgentRunner -> GameServer`.
  One runner, one validator, one action schema, one protocol.
- Every `src/core` change ships with focused tests. Simulation-behaviour tests use
  the real `tests/util/Setup.ts` harness, not mocks.

## Review gate

Plan first and get an independent review before changing `src/core/**`,
`AgentRunner.ts`, `AgentDecisionValidator.ts`, `LegalActionBuilder.ts`,
`AgentObservationBuilder.ts`, `AgentPlannerExecutor.ts`, or `AgentDemoHub.ts`.
Review is mandatory for the last two.

## Outward actions — ask first, every time

Do these only when the operator asked in this conversation: any `git push`,
force-push, branch deletion, history rewrite, deploys, `npm publish`, Coworld
hosted upload/submit/publish, sending external messages, and deleting
replay/benchmark/artifact/evidence files. Land work on a branch off `main`.

Never read or print `.env*`, `proprietary/`, `~/.ssh/`, OAuth stores, tokens, or
auth databases. Checking whether a variable is present is fine.

## Honesty

Tag claims `[repo/file verified]` or `[uncertain / needs confirmation]`. Keep
repository truth, local artifact truth, and live hosted truth separate — never
infer a live package, league binding, ranking, or runtime result from local files.
Report what actually happened, including failures and skipped steps.

## UI text

User-visible strings go through `translateText()` with an English entry in
`resources/lang/en.json`. Crowdin owns every other translation file.
