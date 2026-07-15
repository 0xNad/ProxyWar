# Keystone v40 Commander-retention release — 2026-07-15

Status: uploaded and placed in Qualifiers with automatic champion promotion
requested. v39 remains the active Competition champion until v40 clears the
hosted qualifier. This is a conservative incremental release under the
operator's replacement objective: ship a slightly improved agent, then continue
evidence-driven iteration. It does not claim a proven win-rate increase.

## Decision

Keep the v39 severe-collapse shield and full expert mask. Enable one additional
default-off reliability treatment, `PROXYWAR_KEYSTONE_COMMANDER_RETENTION=1`,
while explicitly keeping `PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY=0`.

The treatment retains the last healthy Commander directive for at most one
resolved degraded refresh when the critical game epoch is unchanged. It checks
phase, own life, alive-player set, and active incoming-attacker set both when
the degraded completion is received and when the retained directive is
delivered. A second degraded refresh must use the ordinary fallback until a new
healthy Commander completion arrives. Original plan age and degradation
telemetry remain visible, and the executor still chooses only a currently
offered canonical `LegalAction.id`.

## Why this candidate

- `[hosted artifact truth]` The private Commander canary had four actual
  retained deliveries at turns 800, 2,600, 4,900, and 5,200, producing six
  marker-tagged decisions and no invalid or rejected Commander output.
- `[hosted artifact truth]` Against the same Asia seat-4 roster/config and
  identical spawn sequence, the retention episode peaked at 193,661 tiles and
  made its last decision at turn 6,100. Its separate control peaked at 87,387
  tiles and stopped at turn 4,600. Treatment outlasted one additional opponent.
  Both episodes still lost with score zero, and Bedrock output was not seeded;
  this is directional survival evidence, not a causal win-rate result.
- `[local paired truth]` Fixed-seed matrix
  `matrix-7338e1eb92766d1dcb358936b35e8d30` compared v39 with the retention arm on
  Asia at seed 7,152,026. With a healthy mock Commander, both jobs were exactly
  identical: Opponent 3 won at turn 8,000, Auri remained alive with 7,382
  tiles, all 316 decisions were accepted, and fallback/degradation were zero.
  This verifies identity outside the intended treatment path.
- `[live hosted truth before release]` v39's first 14 completed Competition
  episodes contained one top-score win (`7.14%`) and mean official score share
  `0.092931`. The newest decision sample had 284 no-output fallbacks and 538
  degraded decisions among 1,022 decisions, making Commander reliability a
  frequent live failure surface.

## Rejected defense experiments

No defense-authority experiment is enabled in v40.

- The broad no-edge v2 treatment regressed the fixed Asia pair from 7,382 Auri
  tiles at turn 8,000 to 4,649 at turn 7,400.
- Cross-target v3 replaced a 10% side attack with a 25% counter. It committed
  about 292,000 extra troops, weakened the strongest nonleader buffer against
  the runaway leader, and reproduced the 4,649-tile regression.
- Reserve-only v4 replaced the same action with hold, but still regressed to
  4,506 tiles with the game ending at turn 7,600.

These results reject the cross-target predicate as a release treatment. They
also identify a separate politics/balance-of-power problem for the next
isolated candidate: do not weaken the strongest anti-leader buffer merely
because it is the current attacker.

## Repository, local, and hosted identity

- `[repository truth]` Candidate branch:
  `codex/keystone-v40-commander-retention`; release image source commit:
  `5a2fcbc42`. Commander-retention behavior itself was introduced at
  `5fe8b0629`; later defense experiments are dormant because the release flag is
  explicitly off.
- `[local test truth]` Five focused suites passed 207/207 tests. Root and
  adapter typechecks passed. Lint reported zero errors and 110 existing
  warnings. Coworld 0.1.30 certification passed all ten stages. Independent
  review found no blocking safety or canonical-action issue.
- `[local image truth]` Linux/AMD64 image
  `proxywar-coworld-local:v40-5a2fcbc42` has local image ID
  `sha256:8a7bbff928eab4f848f9adfc7cd21880674f5770911f79ee01037cdf176eb039`.
- `[hosted truth, 2026-07-15]` Policy label `proxywar-keystone:v40`, UUID
  `accbfb59-27d5-4239-804e-02bf6ffbaea7`.
- Submission UUID: `sub_b30be5f7-798c-45c9-9188-303dd877a923`.
- Qualifier membership UUID: `lpm_3d5efddc-0429-4925-bc74-81f298025c28`.
- Submission status is `placed`; membership is currently
  `qualifying/non-champion` in Qualifiers. Auto-champion mode is `always`.

## Next evidence loop

1. Verify qualifier completion and the resulting Competition champion binding;
   retain v39 as the immediate rollback point.
2. Inspect v40's first completed live episodes for retention exposure, plan age,
   degradation, survival duration, score share, and top-score outcome.
3. Keep the next candidate isolated to politics/balance-of-power behavior; do
   not re-enable the rejected defense authority.

