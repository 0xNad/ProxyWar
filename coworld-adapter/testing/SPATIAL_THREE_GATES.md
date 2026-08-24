# Spatial awareness three-gate evaluation

Status: preregistered before any Gate 1 or Gate 2 provider call.

This evaluation answers a narrower question than the existing 12-run hosted
canary: can the pinned model decode the spatial representations, can it ground
that information into exact currently offered `LegalAction.id` values, and—only
if those diagnostic gates pass—does the treatment improve normal gameplay?

The frozen source under test is
`b8c5c70676e1aee0fe0c31a3546e78679d7cc861`. The certified Coworld arms are:

- OFF: `cow_0de5b358-36a2-44b0-94cb-2b9742fe0c08`;
- STRUCTURED: `cow_8703e8e6-7ad3-45fe-8d56-2bb78abefd0d`;
- FULL: `cow_2da52447-9e32-4cac-8a3a-84d3164da7a4`.

The canonical league package and league binding are out of scope and must not
be changed. Every policy and XP created here is eval-only and unrated.

## Shared invariants

- Model: `us.anthropic.claude-sonnet-4-6`, with the response model recorded.
- All arms use the same policy image and source bytes; the Coworld observation
  flags are the only treatment difference.
- Every gameplay response remains one exact currently offered action ID.
- Gates 1 and 2 execute a deterministic carrier action. The provider answer is
  evidence only and cannot affect the simulation.
- Matched arms must have identical game id, turn, candidate menu, carrier
  action, seed, seat, opponents, and game configuration.
- Provider errors, timeouts, parse failures, missing usage, unmatched states,
  and incomplete evidence are retained. They are never silently excluded.

## Gate 1 — representation comprehension

The probe contains exactly 200 deterministic, source-generated questions:

- 160 questions whose answer is present in schema-5 structured spatial data:
  bearing, distance, shared-border size, mountain share, uncovered frontier,
  and naval exposure;
- 40 questions whose answer requires minimap-v2 ownership or terrain rows.

OFF should abstain (`unknown`) on all questions. STRUCTURED should answer the
160 structured questions and abstain on the 40 minimap-only questions. FULL
should answer all 200. Candidate order and scenario identifiers do not encode
the answer.

Gate 1 passes for STRUCTURED only if:

1. all 200 scenario identities are present exactly once;
2. provider/JSON success is at least 99%;
3. OFF abstention accuracy is at least 90%;
4. STRUCTURED accuracy on the 160 answerable questions is at least 90%;
5. STRUCTURED abstention on minimap-only questions is at least 90%; and
6. FULL structured-question accuracy is no more than two percentage points
   below STRUCTURED.

The minimap representation passes Gate 1 only if FULL accuracy on its 40
minimap-only questions is at least 85% while satisfying the shared requirements.

## Gate 2 — exact offered-action grounding

The probe uses the live `decision_request` rather than a fabricated action
menu. It chooses deterministic diagnostic tasks from exact offered actions:

- structured-target tasks ask for the offered target action satisfying one
  objective spatial criterion (largest shared border, least mountainous
  border, most uncovered frontier, nearest rival, or greatest naval reach);
- minimap-tile tasks ask for the offered positioned action whose exact target
  tile maps to the safest terrain cell in minimap-v2.

The model may return one candidate ID or `unknown`. Its answer is logged but
the deterministic carrier ID is sent to the game. The FULL/STRUCTURED arm
computes the answer key from the admitted spatial observation after the model
call; the answer key is never in the prompt. OFF cannot create an answer key.

Gate 2 passes for STRUCTURED only if:

1. at least 40 matched, uniquely scored structured-target tasks survive;
2. provider/JSON success is at least 99%;
3. every candidate ID was offered in that exact request;
4. menus and carrier IDs match across arms;
5. STRUCTURED exact-ID accuracy is at least 80%;
6. STRUCTURED exceeds OFF by at least 15 percentage points on those tasks; and
7. FULL structured-target accuracy is no more than three percentage points
   below STRUCTURED.

The minimap passes Gate 2 only if at least 20 matched minimap-tile tasks survive,
FULL exact-ID accuracy is at least 75%, and FULL exceeds STRUCTURED by at least
15 percentage points. If real menus do not produce the minimum task count, the
gate is incomplete rather than failed; collect more matched carrier episodes.

## Gate 3 — normal hosted gameplay

Only treatments that pass Gates 1 and 2 advance. The existing four-triplet
Pangaea canary is prior descriptive evidence, not part of the confirmatory
sample.

Canary design: 24 matched treatment sets, map-stratified across Pangaea,
Europe, Asia, World, Oceania, and Black Sea where supported; four seeds per map
class; subject seat rotates 0–3. Each set uses the same frozen LLM subject,
byte-identical deterministic opponents, seed, episode index, map, size,
difficulty, decision cadence, and limits. Arm order is balanced.

Primary gameplay endpoint: subject score. Secondary endpoints: win, final
territory, survival, spatially inconsistent hostile/build choices, action
diversity, provider degradation, prompt/input/output tokens, latency, episode
cost, and replay-derived entertainment. Watchability additionally requires a
blinded pairwise replay review; the automated entertainment score is only a
proxy.

The canary advances to 48 new confirmatory matched sets only if the candidate
has no action-fidelity or provider-reliability regression and its paired mean
score is positive versus OFF. Runtime enablement requires the confirmatory
interval to exclude a practically harmful effect, no increase in invalid or
degraded decisions, and an explicit cost/watchability decision. A null or
negative result keeps the flags OFF.

## Retirement rules

- Retire minimap-v2 if it fails either diagnostic gate, or if it passes the
  diagnostics but shows no incremental gameplay/watchability value while
  retaining its roughly ten-percent incremental prompt cost.
- Retire the current structured encoding if it fails Gate 1 or Gate 2.
- Spatial awareness itself is a dead end only if both the current encoding and
  a compact action-grounded encoding fail exact-action grounding and the
  preregistered hosted confirmatory test. A failure of the raw minimap alone is
  not evidence that spatial information is useless.
