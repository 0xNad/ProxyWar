# Proxy War Bot And Nation Playbook

Last updated: 2026-05-11

This document summarizes built-in nation and tribe behavior so Proxy War agents can learn from it without moving non-deterministic agent logic into core.

## Nation Loop

Primary files:

- `src/core/execution/NationExecution.ts`
- `src/core/execution/utils/AiAttackBehavior.ts`
- `src/core/execution/nation/NationStructureBehavior.ts`
- `src/core/execution/nation/NationAllianceBehavior.ts`

Nations use deterministic pseudo-randomness derived from game id and nation id. Each nation rolls:

- attack tick cadence by difficulty
- troop trigger ratio around 50-60 percent of max troops
- reserve ratio around 30-40 percent of max troops
- expansion ratio around 10-20 percent of max troops

On first active behavior tick, a nation force-sends a large expansion attack into Terra Nullius. Afterwards it periodically handles emoji/diplomacy, structures, warships, embargoes, attacks, and nukes. Structure handling also runs between attack ticks so gold is spent gradually.

## Attack Heuristics To Adapt

Useful behavior to adapt outside core:

- Expand into safe Terra Nullius before fighting players.
- Save troops until reserve and trigger ratios are healthy.
- Use bounded troop commitments for expansion.
- Retaliate against meaningful incoming attacks.
- Prefer bots or weak players that captured structures.
- Prefer very weak targets, traitors, AFK targets, and victims already under heavy attack.
- Avoid FFA attacks into much stronger players.
- In endgame or leader pressure, target the leader more aggressively.
- Use boats only when land expansion or land pressure is unavailable and a reachable target is reasonable.

These ideas belong in `AgentPlannerExecutor`, `AgentStrategicSkills`, `AgentMemoryBuilder`, and `LegalActionBuilder` metadata. They do not require copying nation executions into agent code.

## Structure Heuristics To Adapt

Nation structures are paced by ratios:

- Port: roughly 0.75 per city.
- Factory: roughly 0.75 per city, reduced when ports are available.
- SAM Launcher: 0.15-0.30 per city depending on difficulty.
- Missile Silo: roughly 0.20 per city, with a special first-silo ratio.
- City is the default fallback when other ratios are satisfied.

City and Factory placement prefers:

- safer interior territory
- spacing from same and cross-type structures
- higher elevation
- useful rail/trade connectivity on harder difficulties

Defense Post placement is special. Built-in nations do not treat Defense Posts as generic interior buildings. They build them near active land-attack fronts when:

- incoming land attacks are present
- incoming troops are a meaningful share of own troops
- the post can cover the contested front
- existing posts do not already cover that front

Defense Posts are wasteful when:

- there is no hostile frontier
- the threat is naval only
- the attack is tiny
- the tile is deep interior
- enough posts already cover that front
- economy is still missing and no threat exists

Defense Post active ship targeting is currently not the main reason to build them. The important effect is passive land defense: nearby Defense Posts multiply attacker losses and slow attack progress around covered tiles.

## Current Agent Adaptations

Proxy War agents now expose build-placement metadata on build actions:

- `isBorderBuild`
- `borderDistance`
- `hostileBorderDistance`
- `nearbyEnemyCount`
- `nearbyAllyCount`
- `nearbyIncomingAttack`
- `ownedNeighborCount`
- `frontierValue`
- `economicValue`
- `defensiveValue`
- `buildPlacementReason`

`AgentObservationBuilder` filters Defense Post candidates that have no proven hostile frontier or incoming land-attack value. `StrategicSkillEvaluator`, `RuleAgentBrain`, and `FrontierPolicyExecutor` penalize low-value Defense Posts and reward useful border fortifications. City and Factory actions now carry economic placement reasons.

## What Must Stay Outside Core

The built-in nation code is deterministic core simulation behavior. Proxy War agents should borrow concepts, not move LLMs or product agent logic into core. Agent improvements should stay under `src/server/agents`, scripts, tests, docs, and artifacts.

