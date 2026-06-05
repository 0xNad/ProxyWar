# FrontierAgent Benchmark Runbook

Use this runbook for non-CI FrontierAgent tuning. It intentionally runs longer
than the smoke tests because it evaluates one Codex CLI planned agent against
official `PlayerType.Nation` bots.

Main product mode is `llm-policy-planner`: Codex/LLM refreshes policy
occasionally, and the local `FrontierPolicyExecutor` selects concrete
`LegalAction.id` values every decision step. Local and mock runs are baselines,
not LLM wins.

Default full benchmark:

```bash
AI_LEAGUE_LLM_PROVIDER=codex-cli \
tsx src/scripts/ai-agent-frontier-benchmark.ts \
  --brain=llm-policy-planner \
  --runs=5 \
  --target-wins=3 \
  --nations=3 \
  --map=Pangaea \
  --map-size=Compact \
  --difficulty=Medium
```

Fast local policy check without Codex CLI:

```bash
tsx src/scripts/ai-agent-frontier-benchmark.ts \
  --brain=local-policy-baseline \
  --runs=1 \
  --max-turns=1200 \
  --turns-per-decision=25
```

Mock policy-planner plumbing check:

```bash
tsx src/scripts/ai-agent-frontier-benchmark.ts \
  --brain=mock-policy-planner \
  --runs=1 \
  --max-turns=1200 \
  --turns-per-decision=25
```

Direct Codex action-selector comparison:

```bash
AI_LEAGUE_LLM_PROVIDER=codex-cli \
tsx src/scripts/ai-agent-frontier-benchmark.ts \
  --brain=llm-action-selector \
  --runs=1 \
  --nations=1 \
  --max-turns=1200
```

Strict full-match gate:

```bash
npm run agent:benchmark:bots:full
```

This runs 10 full GameServer/core matches with one Proxy War agent against
5 built-in `PlayerType.Nation` opponents plus 5 built-in tribe/bot opponents on
Pangaea Compact at Easy difficulty. This is the current strict pass gate because
the Medium ladder is still an active behavior-tuning target. It writes both
legacy frontier artifact names and the public gate artifact names:

- `benchmark-summary.json`
- `benchmark-report.md`
- `performance-diagnosis.md`
- per-run AI League artifacts when `--write-replay` is enabled

The gate is PASS only when the Proxy War agent wins 10 out of 10 runs. Any
other result is a behavior-tuning failure and should be followed by diagnosis,
canonical behavior changes, focused tests, and another full benchmark.

CLI override note:

Package scripts provide default benchmark flags, but appended flags are now
parsed with "last value wins" semantics. For example:

```bash
npm run agent:benchmark:bots:full -- \
  --runs=1 \
  --require-wins=1 \
  --nations=3 \
  --bots=0 \
  --max-turns=10000 \
  --write-replay
```

This runs a one-match Medium/Easy override depending on the last supplied
`--difficulty` flag instead of silently keeping the package-script defaults.

Latest passing gate:

- Run id: `2026-05-11T03-29-06-603Z-frontier-mock-policy-planner-90ae84f0`
- Result: 10/10 wins
- Conditions: one Proxy War agent vs 5 built-in nations + 5 built-in
  tribe/bot opponents, Pangaea Compact, Easy, full GameServer/core simulation
- Report:
  `artifacts/ai-league-benchmarks/2026-05-11T03-29-06-603Z-frontier-mock-policy-planner-90ae84f0/benchmark-report.md`
  `artifacts/ai-league-benchmarks/2026-05-11T03-29-06-603Z-frontier-mock-policy-planner-90ae84f0/performance-diagnosis.md`

Latest Medium ladder sample:

- Command:
  `npm run agent:benchmark:bots -- --runs=1 --target-wins=1 --nations=3 --max-turns=10000 --write-replay`
- Run id: `2026-05-11T21-51-08-808Z-frontier-mock-policy-planner-03f9d1d3`
- Result: 1/1 wins
- Conditions: one Proxy War agent vs 3 built-in nations, Pangaea Compact,
  Medium local policy benchmark with `--max-turns=10000`
- Winner: Frontier Agent at turn 7,901 with 81.5% final tile share
- Report:
  `artifacts/ai-league-benchmarks/2026-05-11T21-51-08-808Z-frontier-mock-policy-planner-03f9d1d3/benchmark-report.md`
  `artifacts/ai-league-benchmarks/2026-05-11T21-51-08-808Z-frontier-mock-policy-planner-03f9d1d3/performance-diagnosis.md`

Medium is not yet a final public strength claim. A two-run Medium diagnostic
still found one 71.6% tile-share non-finish and one elimination, so the next
ladder work is broader map/opponent reliability.

Latest full-gate script-path check:

- Command:
  `npm run agent:benchmark:bots:full -- --runs=1 --require-wins=1 --nations=3 --bots=0 --max-turns=10000 --write-replay`
- Run id: `2026-05-11T21-51-46-192Z-frontier-mock-policy-planner-d93d2627`
- Result: 1/1 wins on the `agent:benchmark:bots:full` script's Easy default.
  This validates the package-script path and last-value CLI overrides, not the
  Medium ladder.

Older acceptance target:

- The agent wins at least 3 out of 5 full games.
- Full-game action coverage shows useful non-hold behavior.
- Targeted coverage scenarios offer and select each autonomous gameplay action
  kind at least once.
- `artifacts/ai-league-benchmarks/<run-id>/frontier-report.md` contains win rate,
  action coverage, failure analysis, skill revisions, runtime mode,
  planner/action provider-call counts, latency, token estimates, and estimated
  spend.

Iteration loop:

1. Run the fast local policy check after code changes.
2. Inspect the generated `frontier-report.md`, especially losses, hold rate,
   unsafe attacks, rejected intents, parse failures, and coverage gaps.
3. Adjust `FrontierPolicyExecutor` weights/settings for deterministic behavior.
4. Revise `skills/FrontierAgent/SKILL.md` when Codex CLI plans choose weak
   objectives or omit strategically relevant action kinds.
5. Run the full Codex CLI policy-planner benchmark and keep the report with the
   final run id.
