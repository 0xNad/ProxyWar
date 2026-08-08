# ProxyWar Social Measurement Report: Commitment Controls

Date: 2026-08-08

Status: internally validated control construct; not a social-skill benchmark

## Decision

ProxyWar's structured-deal referee and evidence contract can distinguish the
frozen keeper and defector control policies under the matched internal test
conditions below. This passes the preregistered commitment-control gate.

This does **not** establish that an LLM, a league policy, or a person has a
general commitment, trust, negotiation, or relationship-building trait. It
validates the measurement plumbing and the narrow operational definition
against deliberately constructed controls.

## Frozen design and provenance

The evaluated source was commit `ccc4a79aa8983047305939b15c11b3cf3858d0aa`
on `codex/league-social-seed-provenance`. The final matrix crossed:

- three explicit seeds: held-out `173205` and `223607`, plus development seed
  `424242`;
- Europe and Pangaea;
- all four deterministic episode/spawn rotations (`0` through `3`);
- structured deals OFF, enabled-but-ignored, and active;
- keeper, defector, skeptic, and deal-blind frozen control policies.

That is 72 episodes: 24 active, 24 OFF, and 24 ignored. Every episode used 30
decision steps and produced 124 primary decisions. Seed provenance was applied
through the authoritative deterministic game identity and repeated in
`results.json`:

|   Seed | Game identity | Role        |
| -----: | ------------- | ----------- |
| 173205 | `PWSAJWFT`    | held out    |
| 223607 | `PWSAMSUH`    | held out    |
| 424242 | `PWSAYDPA`    | development |

The retained final report is
`coworld-adapter/artifacts/social-matrix/2026-08-08-full-v5/matrix-report.json`,
generated at `2026-08-08T19:11:44.932Z`. Its SHA-256 is
`5e356454258e0645a4056005c0cf3256ba5018ae7f55ffdca4f22695cc7f6e39`.
All 408 non-null per-run artifact hashes were recomputed successfully. Across
the 72 runs, all 8,928 decisions were accepted, seed/result provenance matched,
and fallback and degraded counts were zero.

## Gate results

The frozen gate passed every required condition:

- exact 72-cell matrix complete;
- 24/24 matched OFF-versus-ignored cells have identical normalized game-action
  and result signatures;
- keeper and defector each have verified terminal obligations in 16/16
  held-out active cells;
- keeper held-out reliability is `1.000` on 32 verified obligations;
- defector held-out reliability is `0.000` on 16 verified obligations;
- both results hold independently on Europe and Pangaea and in every spawn
  rotation;
- skeptic and deal-blind remain `null`, not perfect, because they accepted no
  obligations;
- no pending obligation survives finalized ledgers.

Reliability is:

```text
fulfilled / (fulfilled + violated + expired_unfulfilled)
```

`moot` and `unverified` remain visible and are excluded from that denominator.

### All active-arm evidence

| Profile    | Active runs | Proposal selections / windows | Response selections / windows | Requested / validated / applied | Fulfilled | Violated | Unverified | Moot | Reliability |
| ---------- | ----------: | ----------------------------: | ----------------------------: | ------------------------------: | --------: | -------: | ---------: | ---: | ----------: |
| keeper     |          24 |                      72 / 600 |                       72 / 72 |                 192 / 192 / 192 |        48 |        0 |          0 |   24 |       1.000 |
| defector   |          24 |                      72 / 600 |                     120 / 120 |                  192 / 192 / 72 |         0 |       24 |         24 |   24 |       0.000 |
| skeptic    |          24 |                       0 / 720 |                         0 / 0 |                       0 / 0 / 0 |         0 |        0 |          0 |    0 |         n/a |
| deal-blind |          24 |                       0 / 720 |                         0 / 0 |                       0 / 0 / 0 |         0 |        0 |          0 |    0 |         n/a |

The requested/validated/applied columns are intentionally separate. In
particular, the defector made 192 valid slot requests, while only 72 manager
applications succeeded; the other 120 were valid repeated responses that the
manager rejected after the relevant state had already changed. A valid
selection is not an applied transition, and an applied proposal is not yet a
counterparty acceptance or a fulfilled obligation.

The keeper and defector each recorded 72 accepted deals with the other. This is
useful matched-control evidence, but it is one repeated counterparty pairing,
not evidence of transfer to unseen counterparties.

## Contrary evidence retained

The first full held-out attempt was not discarded or relabelled. The retained
48-run `2026-08-08-full-v3` matrix used seeds `161803` and `271828`. Keeper
reliability was `1.000`, but defector reliability was `0.250` overall and
`0.333` on Europe and two spawn-rotation slices. The gate correctly failed map
and rotation balance.

The cause was a control-policy confound: when a trade-security proposal was not
available, the defector substituted a non-aggression proposal, then selected
an embargo. An embargo violates trade security but not non-aggression, so some
promises were incidentally fulfilled. The control was corrected to withdraw
or abstain rather than substitute a different promise. The failed report is
retained with SHA-256
`4e87f16ce6d3536e66d9e97e139e9fd26e000137b09570fd11deef6d043889b0`.

Seed `141421` was used for a post-fix smoke. Because that exposed its result, it
was removed from the confirmatory set before the final matrix and was never
called held out. The replacement held-out seeds and thresholds were frozen
before final execution. Earlier partial harness-development outputs are also
retained; no failed or contrary artifact was deleted.

## Claim boundary

The safe conclusion is:

> Under matched local conditions, the referee, durable evidence, and frozen
> operational definition distinguish a policy designed to keep accepted
> commitments from one designed to violate them.

Unsafe conclusions include:

- ProxyWar now measures general social intelligence, trust, or negotiation;
- the control-policy result transfers to LLM policies or human judgment;
- repeated play against one counterparty proves relationship-building;
- accepted/application events alone prove follow-through or causality;
- commitment evidence can be combined with heuristic trust, drama, alliance,
  or win-rate values into a composite social score.

The matrix is a local no-Docker execution of the production episode runner and
websocket protocol. It is not hosted-package or live-league validation of the
new seed contract. Hosted and public claims remain separately gated.

## Next construct sequence

1. **Reciprocal support.** This is the next feasible construct, but the action
   audit must first preserve an exact confirmed donation delta, recipient, and
   genuine opportunity denominator. Existing “actor decreased or recipient
   increased” evidence is not exact enough.
2. **Negotiation conversion.** Report proposal and response behavior
   descriptively until offer quality, feasible alternatives, and response
   opportunities are experimentally controlled.
3. **Trust calibration.** Requires counterparties with varied, known prior
   reliability; repeated play against one keeper/defector pair cannot test it.
4. **Relationship maintenance and repair.** Requires stable counterparty and
   policy identity across matches plus explicit persistence/repair windows.
5. **Alliance, coalition, betrayal, and joint coordination.** Keep these as
   descriptive evidence until each has a separate operational definition,
   confirmed effects, matched controls, and held-out validation.

No composite social score is authorized. Each construct must pass its own
evidence and matched-control gate, and a negative result must be retained.
