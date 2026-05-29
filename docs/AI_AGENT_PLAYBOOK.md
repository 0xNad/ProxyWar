# AI Nations League Agent Playbook

This playbook turns current OpenFront gameplay guidance into skills that agents
can use when choosing from `LegalAction[]`. Agents must still choose only a
listed `LegalAction.id`; these skills are decision guidance, not permission to
invent intents.

Sources reviewed:

- OpenFront core gameplay docs:
  https://openfrontio-openfrontio.mintlify.app/guides/gameplay
- OpenFront strategy docs:
  https://openfrontio-openfrontio.mintlify.app/guides/strategies
- OpenFront alliance docs:
  https://openfrontio-openfrontio.mintlify.app/guides/alliances
- OpenFront Wiki Project gold page:
  https://openfront.wiki/Gold
- OpenFront Wiki Project controls page:
  https://openfront.wiki/Controls

## Universal Skills

### Expansion

- Keep growing unless the only available growth is clearly suicidal.
- Prefer neutral expansion when there is adjacent unowned land and no weak
  enemy target.
- Avoid thin, sprawling borders; growth should create defensible territory.
- Do not sit at troop cap. If troops are high and a low-risk expansion or attack
  exists, use some troops.

### Economy

- Build a first City in a safe interior tile when affordable.
- Build Ports on coastal holdings when coastal trade is possible.
- Build Factories when inland or when factory/train routes are likely to be
  safer than ports.
- Prefer Cities and trade economy before expensive late-game units unless under
  immediate threat.
- Conquering weak players can be an economic action because their gold is
  inherited.

### Combat

- Attack weak bordered targets before strong targets.
- Use small or medium troop percentages unless the agent is clearly stronger.
- Larger shared borders make conquest faster, so targets with broader contact
  are better.
- Do not attack allies or teammates.
- Avoid starting several risky wars at once.
- If losing a fight, prefer retreat/preservation once that action is exposed.

### Defense

- Build Defense Posts near vulnerable borders, not randomly in the interior.
- Keep enough troops for defense before spending into economy.
- Secure dangerous flanks through alliances or defensive structures.
- Protect important Cities, Ports, and Factories.

### Diplomacy

- Request alliances with useful neighbors to secure a flank or counter a leader.
- Donate only to allies who remain strategically useful and not threatening.
- Do not auto-extend every alliance; evaluate whether it still helps.
- Use embargoes as pressure when attacks are not legal or not wise.
- Use target marks, quick chat, and emoji as visible intent signals when they
  fit the profile and do not replace a decisive legal attack or survival move.

## Profile Skills

### Aggressive

1. Prefer legal attacks on weak bordered targets.
2. If no enemy attack is legal, expand into neutral land.
3. If no expansion is available, use embargo pressure or build economy.
4. Avoid attacking stronger targets unless the game is otherwise lost.

### Defensive

1. Prefer Defense Posts on vulnerable borders.
2. Build safe Cities/Factories after borders are stable.
3. Request alliances to secure flanks.
4. Expand only with low troop commitment.

### Diplomatic

1. Prefer alliance requests with bordered or strategically useful players.
2. Support allies with gold/troops only when the donation improves survival or
   shared pressure.
3. Build economy if no alliance/support action is legal.
4. Use embargoes when diplomacy is unavailable and a target is non-friendly.

### Opportunistic

1. Prefer low-risk expansion and weak targets.
2. Build economy when no safe attack exists.
3. Take embargo/support actions only when they create a clear advantage.
4. Hold only when every offered non-hold action is harmful or unavailable.

## Current Implementation Notes

- `LlmPromptBuilder` includes a compact version of this playbook.
- `LegalActionBuilder` now exposes neutral expansion as an attack intent with
  `targetID: null` when observation proves adjacent Terra Nullius.
- `AgentStrategicStateBuilder` compresses live observations into a priority,
  urgency, scores, recommended action kinds, target ids, and notes. This helps
  rule and LLM brains reason about the action menu without adding any new core
  logic or bypassing `LegalAction.id` selection.
- `AgentMemoryBuilder` compresses recent accepted decisions into short-term
  memory. Agents can see repeated expansion/build/attack patterns and should
  diversify when another legal action better fits the profile and board state.
- Tactical affordances now include `economy_cadence`, which measures when a
  stable land base and safe City/Factory/Port actions should turn expansion
  into compounding infrastructure.
- Tactical affordances also include `frontier_finish_pressure`, which measures
  when repeated low-commitment probes against a weak bordered rival should turn
  into a decisive existing attack `LegalAction.id`.
- Tactical affordances also include `naval_control`, which measures when safe
  boat, Warship, or move_warship actions should break land-only loops, secure
  sea access, or defend sea lanes through existing `LegalAction.id` choices.
- Tactical affordances also include `late_game_strike_targeting`, which
  measures when legal nukes should hit silos, SAMs, cities, factories, ports, or
  leader-pressure targets through existing `LegalAction.id` choices.
- Tactical affordances also include `personality_diplomacy_pressure`, which
  measures when profile-specific pressure, alliance, support, or communication
  should create visible match story beats through existing `LegalAction.id`
  choices without spamming social actions.
- Match-story reports include a profile differentiation gate. Use it after
  benchmarks to check whether profiles actually look different by action mix,
  hold rate, social pressure, builds, combat, naval use, and late-game strikes.
- Learning reports include Profile Repair Mining, which aggregates profile
  signatures across benchmark runs and lists concrete collapsed-signature,
  stall-risk, neutral-expansion convergence, and missing-expression examples
  before proposing explainable policy/scoring experiments.
- `profileRepairReRank` is the first such experiment. It does not add actions;
  it adjusts scores among offered `LegalAction.id` values when memory shows a
  repeated neutral-expansion or hold loop and a profile-specific alternative is
  already legal.
- Decision metadata records each repair re-rank window, suggested legal action,
  selected/missed outcome, and candidate list so learning reports can measure
  the experiment without opaque training or protocol changes. Reports group
  misses by repair family, so score tuning can start with the most common
  failure mode instead of changing every profile at once.
- Benchmark comparison reports can focus on `profile-differentiation` to compare
  action-mix distance, signature-match rate, distinct-profile run rate, and
  profile stall risk across fixed-seed runs. They also compare profile repair
  families before and after the candidate, which keeps scoring changes tied to
  a measured missed family. Use `--profile=all` in the frontier benchmark when
  you need a compact multi-profile sample.
- Render demos use longer step spacing and replay tail turns so the real
  Open Frontier replay is watchable instead of ending immediately.
- Current late-game work uses mined human replay timing plus built-in nation
  logic for SAM, missile silo, and nuke target priority. Nuclear actions still
  select existing `LegalAction.id` values; target metadata is produced by the
  canonical observation/action path.
