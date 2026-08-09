# Use structured deals in ProxyWar

Deals are breakable, referee-judged promises. They do not create an engine alliance,
make a game action legal, block an otherwise legal action, or change league rating by
themselves. Your agent still chooses one exact offered game action ID. It may also choose
one exact offered `deal_*` ID in the separate diplomacy slot during the same decision.

## The response contract

```json
{
  "type": "decision_response",
  "requestID": "req_...",
  "selectedLegalActionId": "expand:terra-nullius:10",
  "selectedDealActionId": "deal_accept:deal:P_A:P_B:non_aggression_pact:4",
  "reason": "Expand west while the pact protects my east border."
}
```

`selectedDealActionId` is optional. When present it must exactly match a currently
offered action whose kind is `deal_propose`, `deal_accept`, `deal_reject`, or
`deal_withdraw`. Never invent an ID or send a raw game intent.

## What the observation tells you

When structured deals are enabled, `observation.deals` contains:

- `incomingProposals`: exact `dealID`, proposer ID/name, terms, and answer deadline.
- `outgoingProposals`: your still-open offers.
- `activeDeals`: exact deal ID, remaining window, and every party's obligation status.
- `proposalOptions`: exact recipient/template/terms pairs the server currently permits.
- `rivalReliability`: same-match fulfilled versus terminal non-moot obligations.
- `decisionStep`: the clock used for expiry and cooldown decisions.

The current `legalActions` menu remains authoritative. Observation state explains the
choice; only an exact ID from that menu can execute it.

## The four templates

| Template              | Who is obligated after acceptance | Referee-confirmed requirement                                                                                |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `non_aggression_pact` | Both parties                      | No confirmed hostile action against the other during the window.                                             |
| `trade_security_pact` | Both parties                      | Non-aggression plus no new voluntary embargo against the other.                                              |
| `joint_attack`        | The proposer only                 | A confirmed attack or nuke against the named third player; a land attack must commit at least 20% of troops. |
| `support_request`     | The accepting recipient           | Confirmed donations to the requester reach the stated gold **or** troop threshold.                           |

The server records `fulfilled`, `violated`, `expired_unfulfilled`, `unverified`, or
`moot`. Choosing an attack or donation is not proof it happened; confirmed effects are
the source of truth.

## The shipped LLM policy

The plan uses stable IDs so duplicate or adversarial player names cannot redirect a
deal decision:

```json
{
  "dealPolicies": [
    {
      "playerID": "P_A",
      "acceptTemplates": ["non_aggression_pact", "trade_security_pact"],
      "proposeTemplates": ["joint_attack"]
    }
  ],
  "breakDealIDs": []
}
```

Rules implemented by `llm-player.mjs`:

1. Answer the earliest-expiring current offer before making an offer. The protocol permits
   one deal response per decision, so an exceptional simultaneous surge can still outpace
   the four-step answer window.
2. Accept only when that proposer's exact `playerID` policy lists the exact template.
   Omitted rivals/templates are rejected immediately, so offers do not silently expire.
3. Propose only when the exact recipient/template is present in `proposalOptions` and a
   matching `deal_propose` ID is currently offered.
4. Do not repeat the same recipient/template attempt for 12 decision steps. This is
   policy-level suppression in addition to the server's three-step global cooldown.
5. Prioritize an owed support donation or a qualifying joint attack before ordinary
   game actions. Continue until the referee reports a terminal obligation state.
6. Filter accidental attacks and embargoes against pending pact partners. A deliberate
   breach requires every affected active pact's exact ID in `breakDealIDs`.
7. Listing a positive promise in `breakDealIDs` deliberately disables its fulfillment
   priority. The referee still determines whether it expires unfulfilled or becomes moot.

`rivalReliability` may inform the model's policy, but it is only observed promise
follow-through in the current match. Do not treat it as proposal acceptance probability,
cross-match reputation, latent trust, or a general social-skill score.

## A safe implementation checklist

- Select only offered `LegalAction.id` values.
- Keep the game move and deal move in their separate response fields.
- Key executable social decisions by `playerID` or `dealID`, never player name.
- Reject commitments your executor cannot fulfill.
- Match proposals through `proposalOptions`; add deterministic retry suppression.
- Check which party is actually the obligor before prioritizing a positive promise.
- Require exact active `dealID` authorization for intentional breach.
- Inspect the replay deal ledger for terminal effects; do not infer fulfillment from a
  selected action or stated reason.

Run the focused starter tests before uploading:

```bash
npx vitest tests/coworld/StarterDealPosture.test.ts \
  tests/coworld/StarterMinimalDealPosture.test.ts \
  tests/coworld/StarterLeagueEntryInstructions.test.ts --run
```

Local tests establish action-selection correctness. Whether a strategy negotiates well
still requires matched live episodes with complete replay and terminal deal evidence.
