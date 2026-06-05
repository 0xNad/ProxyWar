# Proxy War Agent Architecture

Last updated: 2026-05-11

Proxy War is the product shell around the internal AI Nations League runner. The product promise is a spectator strategy league: humans configure AI nations, enter them into Proxy War matches, and inspect how those nations expanded, built, allied, pressured rivals, or collapsed.

## Canonical Flow

All autonomous play should use this path:

1. Live game state is mirrored outside core by `AgentLocalGameMirror`.
2. `AgentObservationBuilder` converts the game state into an `AgentObservation`.
3. `LegalActionBuilder` exposes proven legal `LegalAction[]` choices.
4. `AgentBrain` or `PlannerExecutorAgentBrain` selects existing `LegalAction.id` values.
5. `AgentDecisionValidator` validates selected ids against the offered list.
6. `AgentRunner` submits validated intents through `GameServer`.
7. `AgentDecisionLogWriter`, audits, scorecards, reports, and replay artifacts explain the result.

LLM and Codex providers never generate raw game intents. They only select offered `LegalAction.id` values.

## Canonical Extension Points

- Observation fields: `src/server/agents/AgentObservationBuilder.ts`
- Legal action availability and metadata: `src/server/agents/LegalActionBuilder.ts`
- Decision safety: `src/server/agents/AgentDecisionValidator.ts`
- Rule decisions: `src/server/agents/RuleAgentBrain.ts`
- Slow planning and fast execution: `src/server/agents/AgentPlannerExecutor.ts`
- Strategic skill scoring: `src/server/agents/AgentStrategicSkills.ts`
- Memory and repetition control: `src/server/agents/AgentMemoryBuilder.ts`
- Objective measurement: `src/server/agents/ObjectiveScorecard.ts`
- Durable artifacts and visual reports: `src/server/agents/AgentDecisionLogWriter.ts`
- Replay artifacts: `src/server/agents/AgentSpectatorReplay.ts`
- Product demo hub: `src/server/agents/AgentDemoHub.ts`
- Manifest-only nation creation: `src/server/agents/ProxyWarNationRegistry.ts`

## What Not To Add

Do not add:

- LLM, Codex CLI, network, or API calls under `src/core`.
- A second agent runner.
- A second action schema.
- A second validator.
- Direct intent submission by agents outside the `AgentRunner -> GameServer` path.
- Free-form action JSON from LLMs.
- One-off scripts that choose raw game intents without `LegalAction.id` validation.

## Current Architecture Audit

No definite production bypass was found in the main league, demo, tournament, planner, Codex, or benchmark paths. The main product flows still use observations, legal actions, selected ids, validation, and `AgentRunner`.

Risk areas to keep visible:

- `AgentDecisionValidator` has both single-decision and batch-validation helpers. `AgentLeagueMatch` currently loops through selected ids and validates each one. This is not a bypass, but it is duplication that should be simplified later.
- `PlannerExecutorAgentBrain` can schedule multiple offered ids from one observation. Each id is still validated before submission, but later actions in the batch are not rebuilt after earlier accepted intents change state. `GameServer` remains the final guard.
- `src/scripts/ai-agent-frontier-benchmark.ts` includes targeted offline policy coverage. Those targeted cases are useful for behavior coverage, but they are not end-to-end proof unless they run through `AgentRunner -> GameServer`.
- `src/scripts/ai-agent-smoke.ts` still contains a legacy hardcoded smoke helper. It is acceptable as a historical smoke path, not as a product behavior path.

## Current Product Commands

- `npm run agent:league-demo:visual`
- `npm run agent:league-demo:watch`
- `npm run agent:league-demo:planner`
- `npm run agent:league-demo:planner:codex-cli`
- `npm run agent:demo-server`
- `npm run agent:tournament:mock`
- `npm run agent:benchmark:bots`

In this shell, `npm` may be unavailable. Use the bundled Node runtime and local binaries when needed:

```sh
PATH=/path/to/node/bin:$PATH
GAME_ENV=dev ./node_modules/.bin/tsx src/scripts/ai-agent-league-smoke.ts --brain=planner --runner=step-locked --scenario=actions
```
