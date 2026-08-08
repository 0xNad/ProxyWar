# ProxyWar Social Evidence Contract: Structured Deals

Status: additive foundation for `DEAL` / `COMMITMENT` evidence. This is not a
social-skill score, trust score, or claim that ProxyWar measures either.

## Scope and authority

The structured-deal referee remains outside `src/core` and does not change the
legal-action architecture:

```text
AgentObservation
-> offered LegalAction[]
-> AgentDecision selecting offered LegalAction.id values
-> AgentDecisionValidator
-> AgentLeagueMatchRunner / AgentDealManager
-> GameServer plus durable evidence
```

Deal actions are runner-scoped `intent: null` meta-actions. An agent may select
one in the primary action slot or, when enabled, in the optional diplomacy
slot. The diplomacy slot can never carry a game intent.

## Evidence state machine

Each stage answers a different question. Consumers must not collapse stages.

| Stage             | Durable evidence                                                                                                     | What it proves                                                                                                                                                              | What it does not prove                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| offered           | `decisions.jsonl.legalActionIDsByKind.deal_*`                                                                        | The exact deal action id was available in that submitted menu.                                                                                                              | The agent noticed, preferred, or selected it.                                                        |
| selected          | primary `selectedLegalActionId`, or bounded `dealSlotEvidence.requestedActionID` plus accepted `validation.actionID` | The primary id is exact; a valid deal-slot selection retains the exact offered id in `validation.actionID`. Invalid agent-controlled text is capped in `requestedActionID`. | The id was manager-applied or produced an effect.                                                    |
| validated         | primary validator outcome, or `dealSlotEvidence.validation`                                                          | The requested id matched the submitted menu and the slot's allowed deal kinds.                                                                                              | The deal manager accepted the state transition.                                                      |
| applied           | primary deal result, or `dealSlotEvidence.application`                                                               | `AgentDealManager` accepted or rejected the requested ledger transition.                                                                                                    | A proposal was accepted by its counterparty, an obligation was fulfilled, or a game effect occurred. |
| response          | `deal-ledger.json` deal status, response step/turn, and `deal_accepted` / `deal_rejected` events                     | The named counterparty accepted or rejected the proposal according to the server referee.                                                                                   | Follow-through on the resulting obligations.                                                         |
| effect / terminal | obligation status, resolution evidence, forced-resolution flag, and verdict events                                   | The server observed the configured compliance fact, violation, elapsed window, moot condition, or match-end adjudication.                                                   | The action caused a later win/state, or that the agent possesses a general social skill.             |

`AgentDecisionRecord.result` and the top-level `decisions.jsonl.result` always
belong to the primary action slot. The diplomacy slot has its own
`dealSlotEvidence`; never infer its validation or manager application from the
primary result.

## `deal-ledger.json`

The file is written only for matches where structured deals were enabled. It
is written after `finalizeDeals()`; attempting to persist an unfinalized ledger
fails. Deals-off matches retain their previous artifact and record shape.

Top-level fields:

- `schemaVersion`: currently `1`.
- `runID`, `matchID`: immutable artifact identity.
- `finalizedAtStep`, `finalizedAtTurn`: match-end referee boundary.
- `decisionSteps[]`: exact step-to-turn mapping and the count of decision
  records that preceded each step.
- `deals[]`: stable-sorted complete proposal/response state.
- `events[]`: server-authored proposal, response, and verdict facts in the
  referee's deterministic causal append/application order.

Every deal has a deterministic `dealID`, proposer and recipient player IDs,
proposal/response steps and turns, its answer and active windows, terms,
status, and obligations. Every obligation has a deterministic `obligationID`,
obligor and counterparty player IDs, kind, promised amounts/target when
applicable, progress, terminal status, resolution step/evidence, and whether
match-end force resolution supplied the verdict.

Terminal obligation states are the existing referee enum:

- `fulfilled`
- `violated`
- `expired_unfulfilled`
- `unverified`
- `moot`

No accepted obligation may remain `pending` in the finalized artifact. Open
proposals become `expired` at match end. A negative covenant still pending at
match end becomes `fulfilled` only in the narrow referee sense that no
confirmed violation was observed during its active window **and** every active
decision step had complete confirmed/not-applicable audit coverage. A coverage
gap produces `unverified`, never inferred fulfilment. A positive commitment
whose usable window was cut short becomes `moot`; one whose window fully
elapsed becomes `expired_unfulfilled`.

## Facts versus claims

Player IDs, steps, turns, deal terms/status, application outcomes, obligation
progress/verdicts, `publicText`, and resolution evidence are server-authored
facts under the current referee rules.

`proposerStatedReason`, `acceptorStatedReason`,
`obligorStatedReason`, and event `statedReason` are sanitized agent-authored
claims. They remain separate from `publicText` and resolution evidence. They
are not intent, causality, truth, or private chain-of-thought. The ledger never
copies raw prompts, raw provider output, or general decision-debug reasoning.

## Safe claims

The artifact can support statements such as:

- “A proposed this exact pact to B at step 4 / turn 100.”
- “B accepted the proposal at step 5.”
- “The referee observed a confirmed qualifying donation during the window.”
- “This obligation ended `expired_unfulfilled` at match end.”
- “A stated this reason for the proposal,” with the text labeled as a claim.

It cannot by itself support statements such as:

- “A trusts B” or “B is trustworthy.”
- “The proposal caused B's later action or the match result.”
- “Manager application means the counterparty accepted.”
- “No confirmed violation means no violation occurred.”
- “This policy is better at commitment, negotiation, or social reasoning.”

Comparative construct claims require repeated matched play with frozen policy
versions, policy/version provenance, repeated counterparties, seat/map
balance, opportunity exposure, and held-out conditions.

## Commitment-keeping construct gate

The measurement unit is one finalized obligation, not a match, proposal, win,
or policy. Report these quantities separately for every policy and condition:

- opportunity windows for each `deal_*` action;
- selected, validated, and applied deal actions;
- accepted obligations and their terms/counterparties;
- `fulfilled`, `violated`, `expired_unfulfilled`, `unverified`, and `moot`
  counts;
- fallback/degraded decisions and primary-action audit coverage.

The narrow reliability estimate is:

```text
fulfilled / (fulfilled + violated + expired_unfulfilled)
```

`unverified` and `moot` remain visible but are excluded. A policy with no
verified terminal obligations has no estimate (`null`), not a perfect score.
Coverage and reliability must always be presented together so abstention cannot
game the construct.

The frozen internal control matrix uses keeper, defector, skeptic, and
deal-blind policies; OFF, enabled-but-ignored, and active arms; three explicit
simulation seeds; Pangaea and Europe; and all four deterministic spawn
rotations. Seed `424242` is development evidence. Seeds `141421` and `223607`
are fresh held-out confirmatory conditions after the control policy is
committed. The original held-out pair (`161803`, `271828`) exposed a
control-policy confound: when trade security was unavailable, the defector
substituted a non-aggression pact that its embargo did not violate. That failed
the preregistered map/rotation gate. The substitution was removed before these
replacement held-out seeds were run; the failed matrix remains retained.

Promotion from “descriptive evidence” to “internally validated control
construct” requires all of the following:

1. every planned cell completes with exact seed/game/replay provenance and no
   fallback or degraded decisions;
2. every matched OFF/ignored cell has an identical normalized game-action and
   result signature;
3. keeper and defector each receive verified terminal obligations in at least
   75% of held-out active cells;
4. keeper reliability is at least 0.90 and defector reliability at most 0.25
   both overall and on the held-out seeds;
5. skeptic and deal-blind abstention remains `null`, demonstrating that
   avoiding commitments is not rewarded as trustworthiness;
6. results hold across both maps and all four spawn rotations, with raw
   opportunity denominators and all contrary cells retained.

Passing this gate validates only that the referee and evidence distinguish the
frozen commitment-control policies under these conditions. It does not show
that an LLM has a general trait, predict human judgment, transfer to unseen
counterparties, or establish negotiation, reciprocity, relationship-building,
trust calibration, betrayal timing, or repair. Each additional construct needs
its own operational definition and matched validation; no composite social
score is authorized.

## Current limits

- This foundation covers structured deals and commitments only. It does not
  unify alliances, donations, chat, targeting, or relationship histories into
  a composite metric.
- Compliance depends on existing confirmed audit facts. Unknown or absent
  effects cannot be promoted to confirmed effects.
- Later state is descriptive, not causal.
- Spectator trust labels, drama scores, relationship heuristics, accepted
  actions, win rate, and one-match narratives remain heuristic presentation
  evidence only. None is a validated social-skill measurement.
- The ledger is a replay/result artifact, not a policy observation channel;
  agent-authored reason text is never injected into another agent's prompt.
