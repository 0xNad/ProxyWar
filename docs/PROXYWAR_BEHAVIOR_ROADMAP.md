# Proxy War Behavior Roadmap

Last updated: 2026-05-11

The next product goal is not just valid actions. Agents should compete with built-in nations, eventually beating them in repeatable benchmarks.

## Current Behavior Model

The agent stack now supports:

- manifest-defined AI nations
- rule, mock LLM, Codex CLI, and planner/executor modes
- live observations
- legal action candidates
- strategic skill scoring
- objective scorecards
- durable decision logs
- visual reports and spectator replay artifacts
- tournaments and evaluations
- a first agent-vs-built-in-nations benchmark command

Action coverage includes spawn, hold, alliance, attack, neutral expansion, City, Factory, Defense Post, Port, SAM, missile/nuke infrastructure, embargo, boats, warships, quick chat, emoji, target marking, delete, upgrade, and donation/support when legal.

## Priority Behavior Fixes

Done in this pass:

- Defense Posts are no longer treated as generic defensive builds.
- Defense Post actions require proven hostile-frontier or incoming-attack value.
- Interior/economic City and Factory builds are preferred when no hostile frontier exists.
- Build actions explain placement through metadata and reports.
- LLM prompts explicitly forbid code/tool output and require JSON-only `LegalAction.id` selection.
- Opening expansion, reserve discipline, early attack sizing, and defensive counterpressure now use nation-inspired heuristics.
- The strict Easy full-match gate passed 10/10 against 5 built-in nations plus 5 built-in tribe/bot opponents.

Next:

1. Move the same 10/10 full-match gate from Easy to Medium difficulty.
2. Reduce high hold-rate periods in winning games by exposing more useful late-game legal actions.
3. Improve target conversion so agents finish medium-strength rivals without attack/retreat loops.
4. Improve alliance selection so diplomatic agents do not protect runaway leaders.
5. Improve support donations so allies receive help only when strategically useful.
6. Add better boat/port heuristics for island maps.
7. Add nuke/SAM timing once late-game state is reliably summarized.

## Competitive Benchmark

Use:

```sh
npm run agent:benchmark:bots
```

Strict full-match gate:

```sh
npm run agent:benchmark:bots:full
```

Latest passing full gate:

- `2026-05-11T03-29-06-603Z-frontier-mock-policy-planner-90ae84f0`
- 10/10 wins
- one Proxy War agent vs 5 built-in nations + 5 built-in tribe/bot opponents
- Pangaea Compact, Easy difficulty
- full GameServer/core simulation
- report: `artifacts/ai-league-benchmarks/2026-05-11T03-29-06-603Z-frontier-mock-policy-planner-90ae84f0/benchmark-report.md`

or, if npm is unavailable in the shell:

```sh
PATH=/path/to/node/bin:$PATH
GAME_ENV=dev ./node_modules/.bin/tsx src/scripts/ai-agent-frontier-benchmark.ts --brain=planner --runs=2 --nations=3 --max-turns=6000
```

Artifacts are written under:

- `artifacts/ai-league-benchmarks/<benchmark-id>/frontier-summary.json`
- `artifacts/ai-league-benchmarks/<benchmark-id>/frontier-report.md`
- per-run Proxy War reports under `artifacts/ai-league-runs/<run-id>/`

The benchmark currently measures one Proxy War agent against built-in `PlayerType.Nation` opponents. Available metrics include survival, winner, tile share, action counts, offered action counts, accepted/rejected intents, audit counts, fallbacks, parser failures, provider attribution, latency, and replay links. If exact placement/win ranking is unavailable, reports use tile share and survival honestly as proxy metrics.

## Where To Add Future Behavior

- Better raw observations: `AgentObservationBuilder`
- Better legal action metadata: `LegalActionBuilder`
- Safety constraints: `AgentDecisionValidator`
- Slow objectives and modules: `AgentPlannerExecutor`
- Fast tactical ranking: `AgentStrategicSkills`
- Repetition and stale-plan detection: `AgentMemoryBuilder`
- Outcome measurement: `ObjectiveScorecard`, tactical affordance learning
  reports such as `economy_cadence`, and action audits
- Product explanation: `AgentDecisionLogWriter`, demo hub, visual reports, spectator replay

Do not put product agent behavior in `src/core` unless the change is a deterministic game rule that should apply to everyone.
