# Proxy War Agent Learning Loop

This loop is for discovering and validating tactics without giving an LLM raw
game control.

## Shape

1. Run deterministic matches through the existing benchmark runner.
2. Record compact tactical affordances on each canonical agent decision.
3. Generate a learning report from benchmark records.
4. Let an LLM or human researcher inspect the compact report and propose one
   small planner/executor experiment.
5. Implement the experiment inside the canonical agent modules only.
6. Re-run the same benchmark seeds and compare win rate, tile share, survival,
   and tactic-specific counters.

The in-match path stays unchanged:

```text
AgentObservation
-> LegalAction[]
-> PlannerExecutor / AgentBrain
-> AgentDecision selecting LegalAction.id
-> AgentDecisionValidator
-> AgentRunner
-> GameServer
```

## Current Tactic Signals

The loop currently records eight tactical affordances.

The match-story artifact also records a profile differentiation gate. It groups
post-spawn decisions by aggressive, defensive, diplomatic, and opportunistic
profiles, compares their action-mix vectors, and flags:

- whether multiple profiles had enough decisions to evaluate
- whether their action mixes are visibly distinct
- hold/stall risk by profile
- neutral-expansion convergence across profiles
- signature labels such as aggressive pressure, defensive posture, diplomatic
  support, and opportunistic mixed play

This gate is post-match analysis only. It does not change the external-agent
protocol, create actions, or let any agent bypass `LegalAction.id`.

The learning report also includes **Profile Repair Mining**. It aggregates the
profile gate across benchmark runs, which matters for `--profile=all` sweeps
where each run may use only one profile. The section emits collapsed-signature,
stall-risk, neutral-expansion convergence, and missing-profile-expression
examples, then turns them into hypotheses and A/B experiment suggestions.

The first repair experiment is `profileRepairReRank`. It is an explainable
profile-aware score adjustment that keeps the same legal action menu but nudges
repeated neutral-expansion or hold loops toward existing profile-specific
alternatives: weak-border pressure for aggressive agents, defense/economy/naval
choices for defensive agents, social support/communication for diplomatic
agents, and mixed high-value pivots for opportunistic agents.
Planner decisions now write repair re-rank telemetry when such a legal window is
available, including the suggested `LegalAction.id`, whether it was selected,
and the top repair candidates. Learning and A/B reports aggregate those rows as
repair opportunities, acted-on count, missed count, act rate, and missed repair
families such as weak hostile attack, economy build, defense build, naval,
diplomacy, communication, pressure signal, and late-game strike. A/B comparison
reports now carry family-level before/after deltas, so tuning should start with
the repair family that still has candidate-side misses instead of changing
unrelated profile weights.

### `frontier_conversion_timing`

This detects when the agent has enough land base, legal neutral growth is no
longer the only good option, and a favorable hostile attack is visible. It
records:

- own tile count, tile share, troop ratio, and recent expansion count
- neutral expansion action count
- hostile attack count and favorable hostile attack count
- best visible conversion target, target tile share, and relative troop ratio
- leader tile-share gap and home danger
- whether the conversion window is recommended

This signal is for the handoff from "grow through neutral land" to "convert a
neighbor." It does not force hostile attacks by itself.

### `opening_expansion_tempo`

This detects when the agent is in the opening window, below an expected
tile-share curve, has legal neutral growth available, and is not under high
home danger. It records:

- own tile count and tile share
- expected opening tile share for the current turn
- leader tile-share gap
- legal land and neutral-boat expansion counts
- home danger
- whether the tactic is recommended

Leader gap is recorded as evidence, but it does not by itself force more
neutral expansion. A smoke A/B showed that blindly chasing leader gap with
neutral expansion can reduce final tile share.

### `frontier_finish_pressure`

This detects when the agent has made repeated low-commitment attacks against an
active bordered rival, a decisive hostile attack is legal, and home danger is not
high. It records:

- active target and repeated probe counts
- visible finishing and decisive attack action counts
- best target id/name, tile share, troop ratio, and attack commitment
- home danger
- whether the tactic is recommended

This signal is for turning visible conflict into a result instead of repeating
10% probes, drifting back to neutral expansion, or holding. It does not create
attack intents; it measures and explains whether an existing hostile attack
`LegalAction.id` should have been selected.

### `economy_cadence`

This detects when the agent has a stable enough land base, safe City/Factory/Port
build actions are visible, and home danger is not high. It records:

- own tile count, tile share, troop ratio, and home danger
- recent expansion count and recent build count
- existing City, Factory, and Port counts
- visible and safe economy build action counts
- the best visible economy build id/unit/economic value
- whether the tactic is recommended

This signal is for the handoff from repeated growth into compounding economy.
It does not create build intents; it measures and explains whether an existing
build `LegalAction.id` should have been selected.

### `naval_control`

This detects when the agent has safe transport, warship, or warship-patrol
actions available, home danger is not high, and sea control is strategically
useful. It records:

- Port and Warship counts
- active transport count and embarked troops
- visible boat launch, neutral boat, naval invasion, Warship build, and Warship
  move counts
- the best visible naval action id/kind/target metadata
- safe naval action count and home danger
- whether the tactic is recommended

This signal is for breaking stale land-only loops and making sea access visible:
explore with transports, defend invasions, build the first Warship when ports
matter, and patrol sea lanes when the action menu supports it. It does not
create naval intents; it measures and explains whether an existing boat,
Warship, or move_warship `LegalAction.id` should have been selected.

### `late_game_strike_targeting`

This detects when legal nuke actions are visible against high-value strategic
targets and the agent is not under high home danger. It records:

- legal strike count and high-value strike count
- silo, SAM, economy, and covered non-SAM target counts
- recent nuke count
- best legal strike id, weapon, target id/name, target structure, SAM coverage,
  and strike score
- whether the tactic is recommended

This signal is for using late-game weapons deliberately against economy,
counterstrike, air-defense, and leader-pressure targets instead of holding or
looping lower-impact actions. It does not create nuke intents; it measures and
explains whether an existing nuke `LegalAction.id` should have been selected.

### `personality_diplomacy_pressure`

This detects when legal social actions can make the match story more visible
without creating a duplicate action system. It records:

- profile and selected personality mode
- pressure, alliance, support, and communication action counts
- recent social-action counts for anti-spam throttling
- best legal social action id/kind/target and score
- home danger
- whether the tactic is recommended

This signal is for making aggressive, defensive, diplomatic, and opportunistic
profiles feel different through existing `target_player`, `embargo`,
`alliance_request`, `alliance_extend`, `break_alliance`, `donate_*`,
`quick_chat`, and `emoji` `LegalAction.id` values. It does not create diplomacy
intents; it measures and explains whether a visible social beat should have
outranked hold, repeated neutral expansion, or another bland loop.

### `transport_troop_banking`

It detects when the agent is near troop cap, has safe transport launch options,
and can bank troops in ships so home population can grow back before the
transport lands. It records:

- current troops, max troops, and troop ratio
- active transport count and troops already banked
- legal boat launch sizes visible to the executor
- incoming home danger
- effective future troop ratio after banking
- whether the tactic is recommended

This is observation and measurement. It does not create actions, intents,
validators, runners, or core game logic.

## Commands

Run a full benchmark:

```bash
npm run agent:benchmark:bots:full -- --difficulty=Hard --nations=5 --bots=0 --run-id=<id>
```

Disable the first tactic for a baseline A/B run:

```bash
npm run agent:benchmark:bots:full -- --difficulty=Hard --nations=5 --bots=0 --run-id=BASELINE_ID --transport-troop-banking=false
```

Opening-tempo executor bias is available as an experiment but is off by
default:

```bash
npm run agent:benchmark:bots:full -- --difficulty=Hard --nations=5 --bots=0 --run-id=CANDIDATE_ID --opening-expansion-tempo=true
```

Every benchmark now writes:

```text
artifacts/ai-league-benchmarks/<id>/learning-report.json
artifacts/ai-league-benchmarks/<id>/learning-report.md
```

Generate or regenerate a learning report from an existing benchmark:

```bash
npm run agent:learn:frontier -- --benchmark-id=<id>
```

That writes:

```text
artifacts/ai-learning/<id>/learning-report.json
artifacts/ai-learning/<id>/learning-report.md
```

Analyze a public human replay:

```bash
npm run agent:learn:human-replay -- --game-id=ahH7r9em
```

That downloads or reuses the archived Proxy War record and writes:

```text
artifacts/human-replays/<game-id>/game-record.json
artifacts/human-replays/<game-id>/human-replay-analysis.json
artifacts/human-replays/<game-id>/human-replay-analysis.md
```

The human replay analyzer does not reconstruct final territory through the
current engine. Historical public replays may require the original upstream
build to reproduce exact final leaderboard state. The first-pass analyzer uses
the archived actions and final per-player stats to extract timing baselines,
tactic tags, and skill guideline candidates.

Mine a small corpus of recent public FFA replays:

```bash
npm run agent:learn:human-replay:mine -- --max-replays=5 --min-players=20
```

The miner lists games through `https://api.openfront.io/public/games`, fetches
selected records with `/public/game/:gameId`, writes each per-game analysis, and
then writes:

```text
artifacts/human-replays/batches/<id>/selected-games.json
artifacts/human-replays/batches/<id>/human-replay-corpus.json
artifacts/human-replays/batches/<id>/human-replay-corpus.md
```

Public replay links use the game ID returned by the API:

```text
https://openfront.io/<workerPath>/game/<gameID>?replay
```

For production, `workerPath(gameID)` is `w${simpleHash(gameID) % 20}`.

Compare an agent run or benchmark against the mined human timing baseline:

```bash
npm run agent:learn:human-opportunities -- --benchmark-id= < benchmark-id > --human-atlas=artifacts/human-replays/batches/ < id > /opportunity-atlas.json
```

For a single rendered league run, pass `--run-id=<run-id>` instead. This writes:

```text
artifacts/ai-league-benchmarks/<benchmark-id>/human-opportunity-report.json
artifacts/ai-league-benchmarks/<benchmark-id>/human-opportunity-report.md
```

The report does not invent actions. It compares existing decision records and
LegalAction visibility against human replay baselines for opening neutral
saturation, early neutral boats, economy timing, and pressure handoff.

Compare two benchmark folders:

```bash
npm run agent:learn:compare -- --baseline-id=<baseline-id> --candidate-id=<candidate-id>
```

That writes:

```text
artifacts/ai-learning-comparisons/<baseline-id>-vs-<candidate-id>/ab-comparison.json
artifacts/ai-learning-comparisons/<baseline-id>-vs-<candidate-id>/ab-comparison.md
```

To focus the comparison on benchmark-level profile differentiation:

```bash
npm run agent:learn:compare -- --baseline-id=<baseline-id> --candidate-id=<candidate-id> --tactic=profile-differentiation
```

That comparison aggregates each run's match-story profile gate, including action
mix distance, signature-match rate, distinct-profile run rate, stall risk, and
neutral-expansion convergence. A single-profile benchmark will usually report
that there was not enough profile data. Use `--profile=all` on the frontier
benchmark to cycle aggressive, defensive, diplomatic, and opportunistic profiles
across fixed-seed runs before comparing.

For repair work, inspect `learning-report.md` first. Its **Profile Repair
Mining** section names failed profile examples and the suggested policy or
scoring repair before running the A/B comparison.

Run the complete fixed-seed A/B gate in one command:

```bash
npm run agent:learn:ab-gate -- --gate-id=GATE_ID --runs=3 --nations=5 --bots=0 --difficulty=Hard
```

The gate runs baseline with transport banking disabled, candidate with transport
banking enabled, then writes the comparison report.

To A/B the opening-tempo executor experiment instead:

```bash
npm run agent:learn:ab-gate -- --gate-id=GATE_ID --tactic=opening-expansion-tempo --runs=3 --nations=5 --bots=0 --difficulty=Hard
```

To A/B the frontier finish-pressure gate:

```bash
npm run agent:learn:ab-gate -- --gate-id=GATE_ID --tactic=frontier-finish-pressure --runs=3 --nations=5 --bots=0 --difficulty=Hard
```

To A/B the human-replay economy cadence gate:

```bash
npm run agent:learn:ab-gate -- --gate-id=GATE_ID --tactic=economy-cadence --runs=3 --nations=5 --bots=0 --difficulty=Hard
```

To A/B the naval-control gate:

```bash
npm run agent:learn:ab-gate -- --gate-id=GATE_ID --tactic=naval-control --runs=3 --nations=5 --bots=0 --difficulty=Hard
```

To A/B the late-game strike-targeting gate:

```bash
npm run agent:learn:ab-gate -- --gate-id=GATE_ID --tactic=late-game-strike-targeting --runs=3 --nations=5 --bots=0 --difficulty=Hard
```

To A/B the personality-diplomacy pressure gate:

```bash
npm run agent:learn:ab-gate -- --gate-id=GATE_ID --tactic=personality-diplomacy-pressure --runs=3 --nations=5 --bots=0 --difficulty=Hard
```

To A/B profile differentiation across the built-in profiles:

```bash
npm run agent:learn:ab-gate -- --gate-id=GATE_ID --tactic=profile-differentiation --runs=4 --nations=5 --bots=0 --difficulty=Hard
```

That gate defaults to `--profile=all`, runs fixed seeds across the four
strategy profiles, toggles `--profile-repair-rerank`, compares the
profile-differentiation metric, and still uses only offered `LegalAction.id`
values.
If a repair run exposes re-rank windows before enough profile signatures exist,
the comparison falls back to repair act rate so early repair experiments remain
measurable instead of inconclusive.

Run one complete opportunity-learning iteration:

```bash
npm run agent:learn:opportunity-loop -- --iteration-id=ITERATION_ID --runs=1 --nations=5 --bots=0 --difficulty=Hard
```

That command runs a hard-nation benchmark, regenerates the learning report,
compares the benchmark to the latest mined human opportunity atlas, writes a
post-match researcher packet, and produces:

```text
artifacts/opportunity-learning-loop/<iteration-id>/iteration-summary.md
```

The human opportunity report now tracks both opening timing and midgame misses:
weak-rival conversion windows, troop-banking boat launches, repeated
low-commitment hostile probes, and attack-safety holds where hostile actions
were visible.

## LLM Usage

Use the `LLM Review Packet` section from `learning-report.md` as the prompt
payload. The LLM should act as a post-match researcher:

- find missed tactic opportunities
- propose one small planner/executor change
- propose one A/B benchmark
- name missing observation fields

It should not choose in-match actions and should never generate raw game
intents.
